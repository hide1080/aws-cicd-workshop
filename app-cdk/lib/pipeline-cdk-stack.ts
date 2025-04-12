import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_codeconnections as codeconnections } from 'aws-cdk-lib';

export class PipelineCdkStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const sourceConnection = new codeconnections.CfnConnection(
      this,
      'cicdWorkshopConnection',
      {
        connectionName: 'cicdWorkshopConnection',
        providerType: 'GitHub',
      }
    );

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