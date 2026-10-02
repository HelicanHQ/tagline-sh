import { fileURLToPath } from 'node:url';
import {
    App,
    CfnOutput,
    Duration,
    RemovalPolicy,
    SecretValue,
    Stack,
    type StackProps,
} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/**
 * Tagline bot on AWS Lambda behind a Function URL (~$0/month on the free tier).
 *
 * Prereqs (once):
 *   1. Secrets Manager secret `tagline/bot` (JSON: APP_ID, WEBHOOK_SECRET, PRIVATE_KEY, AI_API_KEY).
 *   2. `pnpm build` so apps/bot/dist-lambda exists.
 *   3. `pnpm --filter @tagline-sh/infra exec cdk bootstrap`
 */

const REGION = 'eu-central-1';
const SECRET_ID = 'tagline/bot';
const GITHUB_REPO = 'HelicanHQ/tagline-sh';

/** Resolved by CloudFormation at deploy time; the value never lands in the template. */
const secret = (field: string): string =>
    SecretValue.secretsManager(SECRET_ID, { jsonField: field }).unsafeUnwrap();

class BotStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        const fn = new lambda.Function(this, 'Bot', {
            runtime: lambda.Runtime.NODEJS_24_X,
            architecture: lambda.Architecture.ARM_64,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(
                fileURLToPath(new URL('../apps/bot/dist-lambda', import.meta.url)),
            ),
            memorySize: 512,
            // The AI call on /release-report can be slow. GitHub gives up waiting after 10s
            // but the invocation keeps running and still posts the comment.
            timeout: Duration.seconds(60),
            logGroup: new logs.LogGroup(this, 'BotLogs', {
                retention: logs.RetentionDays.TWO_WEEKS,
                removalPolicy: RemovalPolicy.DESTROY,
            }),
            environment: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info',
                APP_ID: secret('APP_ID'),
                WEBHOOK_SECRET: secret('WEBHOOK_SECRET'),
                PRIVATE_KEY: secret('PRIVATE_KEY'),
                AI_API_KEY: secret('AI_API_KEY'),
                AI_BASE_URL: 'https://openrouter.ai/api/v1',
                AI_MODEL: 'openai/gpt-4o-mini',
            },
        });

        // No IAM auth: GitHub can't sign SigV4. The webhook HMAC signature is the auth.
        const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

        new CfnOutput(this, 'WebhookUrl', { value: `${url.url}api/github/webhooks` });
    }
}

/** Lets GitHub Actions on main deploy via OIDC, by assuming the CDK bootstrap roles. No stored AWS keys. */
class DeployAccessStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        const provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
            url: 'https://token.actions.githubusercontent.com',
            clientIds: ['sts.amazonaws.com'],
        });

        const role = new iam.Role(this, 'GitHubDeployRole', {
            roleName: 'tagline-github-deploy',
            assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
                StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
                StringLike: {
                    'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:ref:refs/heads/main`,
                },
            }),
            maxSessionDuration: Duration.hours(1),
        });
        role.addToPolicy(
            new iam.PolicyStatement({
                actions: ['sts:AssumeRole'],
                resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
            }),
        );

        new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
    }
}

const app = new App();
const env = { account: process.env['CDK_DEFAULT_ACCOUNT'], region: REGION };
new BotStack(app, 'TaglineBot', { env });
new DeployAccessStack(app, 'TaglineDeployAccess', { env });
