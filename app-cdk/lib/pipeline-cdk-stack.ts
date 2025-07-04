import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_codeconnections as codeconnections } from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

interface ConsumerProps extends StackProps {
  ecrRepository: ecr.Repository;
  testEcsClusterName: string;
  testEcsServiceName: string;
  testVpc: ec2.IVpc;
  prodEcsClusterName: string;
  prodEcsServiceName: string;
  prodVpc: ec2.IVpc;
  greenTargetGroup: elbv2.ApplicationTargetGroup;
  greenLoadBalancerListener: elbv2.ApplicationListener;
  blueTargetGroup: elbv2.ApplicationTargetGroup;
  blueLoadBalancerListener: elbv2.ApplicationListener;
}

export class PipelineCdkStack extends Stack {
  constructor(scope: Construct, id: string, props: ConsumerProps) {
    super(scope, id, props);

    const sourceConnection = new codeconnections.CfnConnection(
      this,
      'cicdWorkshopConnection',
      {
        connectionName: 'cicdWorkshopConnection',
        providerType: 'GitHub',
      }
    );

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'cicdWorkshopPipeline',
      crossAccountKeys: false,
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.QUEUED,
    });

    const codeBuild = new codebuild.PipelineProject(this, 'CodeBuild', {
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          computeType: codebuild.ComputeType.SMALL,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-test.yml'),
      },
    );

    const dockerBuild = new codebuild.PipelineProject(this, 'DockerBuild', {
        environmentVariables: {
          IMAGE_TAG: { value: 'latest'},
          IMAGE_REPO_URI: { value: props.ecrRepository.repositoryUri },
          AWS_DEFAULT_REGION: { value: process.env.CDK_DEFAULT_REGION },
        },
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          computeType: codebuild.ComputeType.SMALL,
        },
        buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-docker.yml'),
      },
    ) ;

    const dockerBuildRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:GetRepositoryPolicy',
        'ecr:DescribeRepositories',
        'ecr:ListImages',
        'ecr:DescribeImages',
        'ecr:BatchGetImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
        'ecr:PutImage',
      ]
    })

    dockerBuild.addToRolePolicy(dockerBuildRolePolicy);

    const signerArnParameter = new ssm.StringParameter(this, 'signerArnParameter', {
      parameterName: 'signer-profile-arn',
      stringValue: 'arn:aws:signer:us-west-2:539247483723:/signing-profiles/ecr_signing_profile',
    });

    const signerParameterPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [signerArnParameter.parameterArn],
      actions: ['ssm:GetParametersByPath', 'ssm:GetParameters'],
    })

    const signerPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        'signer:PutSigningProfile',
        'signer:SignPayload',
        'signer:GetRevocationStatus'
      ],
    })

    dockerBuild.addToRolePolicy(signerParameterPolicy);
    dockerBuild.addToRolePolicy(signerPolicy);

    const sourceOutput = new codepipeline.Artifact();
    const unitTestOutput = new codepipeline.Artifact();
    const dockerBuildOutput = new codepipeline.Artifact();

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: 'GitHub',
          owner: 'hide1080',
          repo: 'aws-cicd-workshop',
          output: sourceOutput,
          branch: 'main',
          connectionArn: 'arn:aws:codeconnections:us-west-2:539247483723:connection/ceca47d8-ab84-44cb-bb3d-4a3df6bc5d85',
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Code-Quality-Testing',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Unit-Test',
          project: codeBuild,
          input: sourceOutput,
          outputs: [unitTestOutput],
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Docker-Push-ECR',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Docker-Build',
          project: dockerBuild,
          input: sourceOutput,
          outputs: [dockerBuildOutput],
        }),
      ],
    });

    // ECS クラスターとサービスを名前からインポート
    const testEcsCluster = ecs.Cluster.fromClusterAttributes(this, 'TestEcsCluster', {
      clusterName: props.testEcsClusterName,
      vpc: props.testVpc,
    });
    
    const testEcsService = ecs.FargateService.fromFargateServiceAttributes(this, 'TestEcsService', {
      serviceName: props.testEcsServiceName,
      cluster: testEcsCluster,
    });

    pipeline.addStage({
      stageName: 'Deploy-Test',
      actions: [
        new codepipeline_actions.EcsDeployAction({
          actionName: 'Deploy-Fargate-Test',
          service: testEcsService,
          input: dockerBuildOutput,
        }),
      ],
    });

    const prodEcsCluster = ecs.Cluster.fromClusterAttributes(this, 'ProdEcsCluster', {
      clusterName: props.prodEcsClusterName,
      vpc: props.prodVpc,
    });
    
    const prodEcsService = ecs.FargateService.fromFargateServiceAttributes(this, 'ProdEcsService', {
      serviceName: props.prodEcsServiceName,
      cluster: prodEcsCluster,
    });

    const ecsCodeDeployApp = new codedeploy.EcsApplication(this, "my-app", { applicationName: 'my-app' });
    const prodEcsDeploymentGroup = new codedeploy.EcsDeploymentGroup(this, "my-app-dg", {
      service: prodEcsService,
      blueGreenDeploymentConfig: {
        blueTargetGroup: props.blueTargetGroup,
        greenTargetGroup: props.greenTargetGroup,
        listener: props.blueLoadBalancerListener,
        testListener: props.greenLoadBalancerListener
      },
      deploymentConfig: codedeploy.EcsDeploymentConfig.LINEAR_10PERCENT_EVERY_1MINUTES,
      application: ecsCodeDeployApp,
    });
    pipeline.addStage({
      stageName: 'Deploy-Production',
      actions: [
        new codepipeline_actions.ManualApprovalAction({
          actionName: 'Approve-Prod-Deploy',
          runOrder: 1
        }),
        new codepipeline_actions.CodeDeployEcsDeployAction({
          actionName: 'BlueGreen-deployECS',
          deploymentGroup: prodEcsDeploymentGroup,
          appSpecTemplateInput: sourceOutput,
          taskDefinitionTemplateInput: sourceOutput,
          runOrder: 2
        })
      ]
    });

    new CfnOutput(
      this,
      'sourceConnectionArn',
      { value: sourceConnection.attrConnectionArn }
    );

    new CfnOutput(
      this,
      'sourceConnectionStatus',
      { value: sourceConnection.attrConnectionStatus }
    );
  }
}