import { promises as fs } from 'node:fs';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { ReleasePlanSchema } from '@tagline-sh/shared';
import {
    executeProposeRelease,
    executeFinalizeRelease,
    type ExecutorOctokit,
} from '~/app/release-executor';

/**
 * Action entry point. Auto-detects which phase to run from the workflow
 * event:
 *
 *   - `workflow_dispatch` with a `release_plan` input → Phase A (propose):
 *     bump, changelog, commit, push branch, open PR. No tag, no release.
 *
 *   - `pull_request: closed` (merged, head ref `release/*`) → Phase B
 *     (finalize): tag the merge commit, create GitHub Release(s), comment
 *     on the merged PR.
 *
 * Any other event is a no-op with a logged warning.
 *
 * Never throws — failures are surfaced via `core.setFailed()` so the
 * workflow shows red without nuking the action runner.
 */
async function run(): Promise<void> {
    try {
        const githubToken = core.getInput('github_token', { required: true });
        const octokit = github.getOctokit(githubToken) as unknown as ExecutorOctokit;
        const workspaceRoot = process.env['GITHUB_WORKSPACE'] ?? process.cwd();

        const eventName = process.env['GITHUB_EVENT_NAME'] ?? 'workflow_dispatch';

        if (eventName === 'pull_request') {
            await runFinalize(octokit);
            return;
        }

        // Default: propose mode (workflow_dispatch or anything else with a
        // release_plan payload).
        await runPropose(octokit, workspaceRoot);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.setFailed(`Tagline action crashed: ${message}`);
    }
}

async function runPropose(octokit: ExecutorOctokit, workspaceRoot: string): Promise<void> {
    const releasePlanInput = core.getInput('release_plan', { required: true });
    const issueNumberRaw = core.getInput('issue_number');
    const dryRunRaw = core.getInput('dry_run');

    const plan = ReleasePlanSchema.parse(JSON.parse(releasePlanInput));

    if (dryRunRaw === 'true') plan.isDryRun = true;
    if (issueNumberRaw && /^\d+$/.test(issueNumberRaw)) {
        plan.issueNumber = Number(issueNumberRaw);
    }

    const result = await executeProposeRelease(plan, { octokit, workspaceRoot });
    if (!result.success) {
        core.setFailed(result.error ?? 'Release proposal failed');
    }
}

interface PullRequestEvent {
    action?: string;
    pull_request?: {
        number: number;
        merged: boolean;
        merge_commit_sha?: string | null;
        head?: { ref?: string };
        base?: { ref?: string };
        body?: string | null;
    };
    repository?: {
        name: string;
        owner: { login: string };
    };
}

async function runFinalize(octokit: ExecutorOctokit): Promise<void> {
    const eventPath = process.env['GITHUB_EVENT_PATH'];
    if (!eventPath) {
        core.warning('GITHUB_EVENT_PATH unset on pull_request event — skipping finalize.');
        return;
    }
    const raw = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(raw) as PullRequestEvent;

    if (event.action !== 'closed') {
        core.info(`pull_request.${event.action ?? '?'} — skipping (only 'closed' triggers finalize).`);
        return;
    }
    if (!event.pull_request?.merged) {
        core.info('PR was closed without merging — skipping finalize.');
        return;
    }
    const headRef = event.pull_request.head?.ref ?? '';
    if (!headRef.startsWith('release/')) {
        core.info(`PR head ref is "${headRef}" — skipping (finalize only runs on release/* branches).`);
        return;
    }

    const mergeSha = event.pull_request.merge_commit_sha;
    if (!mergeSha) {
        core.setFailed('Merged PR has no merge_commit_sha — cannot finalize.');
        return;
    }

    const owner = event.repository?.owner.login;
    const name = event.repository?.name;
    if (!owner || !name) {
        core.setFailed('Could not resolve repository owner/name from event payload.');
        return;
    }

    const workspaceRoot = process.env['GITHUB_WORKSPACE'] ?? process.cwd();
    const result = await executeFinalizeRelease(
        {
            repoOwner: owner,
            repoName: name,
            mergeSha,
            prNumber: event.pull_request.number,
            prBody: event.pull_request.body ?? null,
            headRef,
        },
        { octokit, workspaceRoot },
    );
    if (!result.success) {
        core.setFailed(result.error ?? 'Release finalize failed');
    }
}

void run();
