import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

interface ConsumerProps extends StackProps {
  ecrRepository: ecr.Repository;
}

export class AppCdkStack extends Stack {
  public readonly vpc: ec2.IVpc;
  public readonly ecsClusterName: string;
  public readonly ecsServiceName: string;
  public readonly greenTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly greenLoadBalancerListener: elbv2.ApplicationListener;
  public readonly blueTargetGroup: elbv2.ApplicationTargetGroup;
  public readonly blueLoadBalancerListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: ConsumerProps) {
    super(scope, `${id}-app-stack`, props);

    this.vpc = new ec2.Vpc(this, `${id}-vpc`, {
      natGateways: 0,
      subnetConfiguration: [
        {
          subnetType: ec2.SubnetType.PUBLIC,
          name: 'public',
          cidrMask: 24,
        },
      ],
    });
    this.ecsClusterName = `${id}-ecs-cluster`;
    this.ecsServiceName = `${id}-fargate-service`;

    const cluster = new ecs.Cluster(this, `${id}-ecs-cluster`, {
      vpc: this.vpc,
      clusterName: this.ecsClusterName,
    });

    let fargateService: ecsPatterns.ApplicationLoadBalancedFargateService;

    if (`${id}` === 'prod') {
      fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        `${id}-fargate-service`,
        {
          cluster: cluster,
          serviceName: this.ecsServiceName,
          publicLoadBalancer: true,
          assignPublicIp: true,
          taskSubnets: {
            subnetType: ec2.SubnetType.PUBLIC,
          },
          memoryLimitMiB: 512,
          cpu: 256,
          desiredCount: 1,
          taskImageOptions: {
            image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository),
            containerName: 'my-app',
            containerPort: 8081
          },
          deploymentController: {
            type: ecs.DeploymentControllerType.CODE_DEPLOY,
          },
        },
      );
      this.greenLoadBalancerListener = fargateService.loadBalancer.addListener(
        `${id}-green-load-balancer-listener`,
        {
          port: 81,
          protocol: elbv2.ApplicationProtocol.HTTP,
        },
      );
      this.greenTargetGroup = new elbv2.ApplicationTargetGroup(
        this,
        `${id}-green-target-group`,
        {
          port: 80,
          targetType: elbv2.TargetType.IP,
          vpc: this.vpc,
        },
      );
      this.greenLoadBalancerListener.addTargetGroups(
        `${id}-green-listener`,
        {
          targetGroups: [this.greenTargetGroup],
        },
      );
      this.greenTargetGroup.configureHealthCheck({
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: Duration.seconds(10),
        interval: Duration.seconds(11),
        path: "/my-app",
      });
      this.blueTargetGroup = fargateService.targetGroup
      this.blueLoadBalancerListener = fargateService.listener
    } else {
      fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        `${id}-fargate-service`,
        {
          cluster: cluster,
          serviceName: this.ecsServiceName,
          publicLoadBalancer: true,
          assignPublicIp: true,
          taskSubnets: {
            subnetType: ec2.SubnetType.PUBLIC,
          },
          memoryLimitMiB: 512,
          cpu: 256,
          desiredCount: 1,
          taskImageOptions: {
            image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository),
            containerName: 'my-app',
            containerPort: 8081
          },
        },
      );
    }

    fargateService.targetGroup.configureHealthCheck({
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      timeout: Duration.seconds(10),
      interval: Duration.seconds(11),
      path: '/my-app',
    });

    fargateService.targetGroup.setAttribute(
      'deregistration_delay.timeout_seconds',
      '5',
    );
  }
}
