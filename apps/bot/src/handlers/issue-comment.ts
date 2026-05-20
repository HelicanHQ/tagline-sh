import type { Context, Probot } from 'probot';
import { APP_DISPLAY_NAME } from '@tagline-sh/shared';
import { buildReleaseReport } from '~/app/commands/release-report';
import {
    buildApprovePlan,
    dispatchReleaseWorkflow,
    parseApproveCommand,
    type DispatchOctokit,
} from '../commands/approve.js';
import type { ReaderOctokit } from '~/app/services/octokit-reader';
import {
    acknowledgementComment,
    errorComment,
    missingWorkflowComment,
    noChangesComment,
    noPermissionComment,
    reportComment,
} from '~/app/utils/comments';
import { checkWritePermission, type PermissionsOctokit } from '~/app/utils/permissions';

// Probot's `context.octokit` and the bare `octokit` package's `Octokit` are
// structurally identical for the methods we use, but their TypeScript types
// differ — probot bundles an older `@octokit/plugin-rest-endpoint-methods`
// (missing `campaigns`/`hostedCompute`) and adds retry-shim intersections.
// Both work at runtime, so we adapt once at the handler boundary.
const asReader = (octokit: Context['octokit']): ReaderOctokit =>
    octokit as unknown as ReaderOctokit;
const asPermissions = (octokit: Context['octokit']): PermissionsOctokit =>
    octokit as unknown as PermissionsOctokit;
const asDispatch = (octokit: Context['octokit']): DispatchOctokit =>
    octokit as unknown as DispatchOctokit;

const COMMAND_RE = /^\/(\S+)(?:\s+(.*))?$/;

interface AIConfig {
    apiKey: string;
    baseUrl?: string;
    model?: string;
}

function readAIConfig(): AIConfig | undefined {
    const apiKey = process.env['AI_API_KEY'];
    if (!apiKey) return undefined;
    return {
        apiKey,
        baseUrl: process.env['AI_BASE_URL'],
        model: process.env['AI_MODEL'],
    };
}

/**
 * Route an issue/PR comment to a slash command. Performs the bot/permission
 * filter up-front so command handlers do not have to repeat it.
 *
 * Exported as a free function so it is unit-testable with a synthetic Context.
 */
export async function handleIssueComment(context: Context<'issue_comment.created'>): Promise<void> {
    const comment = context.payload.comment;
    const sender = context.payload.sender;

    // Ignore bots — including ourselves — to prevent feedback loops.
    if (sender.type === 'Bot') return;

    const body = comment.body.trim();
    const matched = COMMAND_RE.exec(body);
    if (!matched) return;

    const command = matched[1]!.toLowerCase();
    const args = (matched[2] ?? '').trim();

    const repo = context.repo();
    const issueNumber = context.payload.issue.number;

    const allowed = await checkWritePermission(asPermissions(context.octokit), repo, sender.login);
    if (!allowed) {
        await context.octokit.rest.issues.createComment({
            ...repo,
            issue_number: issueNumber,
            body: noPermissionComment(sender.login),
        });
        return;
    }

    switch (command) {
        case 'release-report':
            await runReleaseReport(context, args);
            return;
        case 'approve':
            await runApprove(context, sender.login, args);
            return;
        default:
            return;
    }
}

async function runReleaseReport(
    context: Context<'issue_comment.created'>,
    args: string,
): Promise<void> {
    const repo = context.repo();
    const issueNumber = context.payload.issue.number;

    const branchMatch = /--branch\s+(\S+)/.exec(args);
    const branchOverride = branchMatch?.[1];

    const ack = await context.octokit.rest.issues.createComment({
        ...repo,
        issue_number: issueNumber,
        body: acknowledgementComment('report'),
    });

    try {
        const buildOpts: Parameters<typeof buildReleaseReport>[0] = {
            octokit: asReader(context.octokit),
            owner: repo.owner,
            repo: repo.repo,
        };
        if (branchOverride) buildOpts.branch = branchOverride;
        const ai = readAIConfig();
        if (ai) buildOpts.ai = ai;

        const { report } = await buildReleaseReport(buildOpts);

        const body =
            report.prs.length === 0 ? noChangesComment(report.lastTag) : reportComment(report);

        await context.octokit.rest.issues.updateComment({
            ...repo,
            comment_id: ack.data.id,
            body,
        });
    } catch (err) {
        context.log.error({ err }, 'release-report failed');
        await context.octokit.rest.issues.updateComment({
            ...repo,
            comment_id: ack.data.id,
            body: errorComment('generating the release report'),
        });
    }
}

async function runApprove(
    context: Context<'issue_comment.created'>,
    approvedBy: string,
    args: string,
): Promise<void> {
    const repo = context.repo();
    const issueNumber = context.payload.issue.number;

    const command = parseApproveCommand(args);
    if (!command) {
        await context.octokit.rest.issues.createComment({
            ...repo,
            issue_number: issueNumber,
            body:
                `${APP_DISPLAY_NAME}: I didn't understand that \`/approve\` command. ` +
                'Valid forms: `/approve`, `/approve patch|minor|major`, `/approve as X.Y.Z`, ' +
                'plus `--draft` / `--dry-run`.',
        });
        return;
    }

    const ack = await context.octokit.rest.issues.createComment({
        ...repo,
        issue_number: issueNumber,
        body: acknowledgementComment('approve'),
    });

    try {
        const buildInput: Parameters<typeof buildApprovePlan>[0] = {
            octokit: asReader(context.octokit),
            owner: repo.owner,
            repo: repo.repo,
            command,
            approvedBy,
            issueNumber,
        };
        const ai = readAIConfig();
        if (ai) buildInput.ai = ai;

        const result = await buildApprovePlan(buildInput);

        if (!result.ok) {
            await context.octokit.rest.issues.updateComment({
                ...repo,
                comment_id: ack.data.id,
                body: `${APP_DISPLAY_NAME}: ${result.error}`,
            });
            return;
        }

        const { plan, empty } = result;

        if (empty) {
            await context.octokit.rest.issues.updateComment({
                ...repo,
                comment_id: ack.data.id,
                body: noChangesComment(plan.lastTag),
            });
            return;
        }

        const dispatch = await dispatchReleaseWorkflow(
            asDispatch(context.octokit),
            repo.owner,
            repo.repo,
            plan,
        );

        if (dispatch.missingWorkflow) {
            await context.octokit.rest.issues.updateComment({
                ...repo,
                comment_id: ack.data.id,
                body: missingWorkflowComment(),
            });
            return;
        }

        if (!dispatch.dispatched) {
            context.log.error({ dispatch }, 'workflow_dispatch failed');
            await context.octokit.rest.issues.updateComment({
                ...repo,
                comment_id: ack.data.id,
                body: errorComment('dispatching the release workflow', dispatch.error),
            });
            return;
        }

        context.log.info(
            { payloadBytes: dispatch.payloadBytes },
            'workflow_dispatch succeeded',
        );

        await context.octokit.rest.issues.updateComment({
            ...repo,
            comment_id: ack.data.id,
            body: buildDispatchAckBody(plan, repo),
        });
    } catch (err) {
        context.log.error({ err }, 'approve failed');
        await context.octokit.rest.issues.updateComment({
            ...repo,
            comment_id: ack.data.id,
            body: errorComment('preparing the release'),
        });
    }
}

function buildDispatchAckBody(
    plan: Extract<Awaited<ReturnType<typeof buildApprovePlan>>, { ok: true }>['plan'],
    repo: { owner: string; repo: string },
): string {
    const tag = `v${plan.nextVersion}`;
    const workflowsUrl = `https://github.com/${repo.owner}/${repo.repo}/actions/workflows/release-agent.yml`;
    const flags: string[] = [];
    if (plan.isDraft) flags.push('draft');
    if (plan.isDryRun) flags.push('dry-run');
    const flagsLine = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    return [
        `${APP_DISPLAY_NAME} is releasing \`${tag}\`${flagsLine} — workflow dispatched by @${plan.approvedBy}.`,
        '',
        `Track progress: ${workflowsUrl}`,
    ].join('\n');
}

export function register(app: Probot): void {
    app.on('issue_comment.created', handleIssueComment);
}
