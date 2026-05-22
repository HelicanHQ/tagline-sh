import * as core from '@actions/core';
import * as github from '@actions/github';
import { type ExecutorOctokit } from '~/app/release-executor';
import { runFinalize, runFinalizeFromPush, runPropose } from '~/app/runners';

/**
 * Action entry point. Auto-detects which phase to run from the workflow
 * event:
 *
 *   - `workflow_dispatch` with a `release_plan` input → Phase A (propose):
 *     bump, changelog, commit, push branch, open PR. No tag, no release.
 *
 *   - `push` on `main`/`master` whose head commit is the merge commit of a
 *     `release/*` PR → Phase B (finalize): tag the merge commit, create
 *     GitHub Release(s), comment on the merged PR. We trigger from `push`
 *     because GitHub's anti-recursion behavior suppresses `pull_request`
 *     events for PRs opened with the default `GITHUB_TOKEN`.
 *
 *   - `pull_request: closed` (merged, head ref `release/*`) → Phase B
 *     (legacy/PAT path): same finalize logic. Works only if the workflow
 *     uses a PAT or App-installation token to open the PR.
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
        // Up-front diagnostics so a confused Phase B is debuggable from the log
        // alone. Every reason finalize might no-op gets surfaced below.
        core.info(`Tagline action starting — GITHUB_EVENT_NAME=${eventName}`);
        core.info(`  GITHUB_REPOSITORY=${process.env['GITHUB_REPOSITORY'] ?? '<unset>'}`);
        core.info(`  GITHUB_REF=${process.env['GITHUB_REF'] ?? '<unset>'}`);
        core.info(`  GITHUB_SHA=${process.env['GITHUB_SHA'] ?? '<unset>'}`);

        if (eventName === 'push') {
            core.info(
                'Routing to Phase B (finalize via push) — checking if HEAD is a release-PR merge.',
            );
            await runFinalizeFromPush(octokit, workspaceRoot);
            return;
        }

        if (eventName === 'pull_request') {
            core.info('Routing to Phase B (finalize via pull_request) — legacy PAT path.');
            await runFinalize(octokit, workspaceRoot);
            return;
        }

        core.info(`Routing to Phase A (propose) — event "${eventName}" is workflow_dispatch.`);
        await runPropose(octokit, workspaceRoot);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.setFailed(`Tagline action crashed: ${message}`);
    }
}

void run();
