import * as core from '@actions/core';
import * as github from '@actions/github';
import { ReleasePlanSchema } from '@tagline-sh/shared';
import { executeRelease, type ExecutorOctokit } from './release-executor.js';

/**
 * Action entry point. Reads inputs, validates the `release_plan` JSON, and
 * delegates to the executor. Never throws — failures are surfaced via
 * `core.setFailed()`.
 */
async function run(): Promise<void> {
    try {
        const releasePlanInput = core.getInput('release_plan', { required: true });
        const githubToken = core.getInput('github_token', { required: true });
        const issueNumberRaw = core.getInput('issue_number');
        const dryRunRaw = core.getInput('dry_run');

        const plan = ReleasePlanSchema.parse(JSON.parse(releasePlanInput));

        // Action-level overrides: `dry_run` workflow input wins, since users may
        // re-run a previous workflow with the same plan in dry mode.
        if (dryRunRaw === 'true') plan.isDryRun = true;
        if (issueNumberRaw && /^\d+$/.test(issueNumberRaw)) {
            plan.issueNumber = Number(issueNumberRaw);
        }

        const octokit = github.getOctokit(githubToken) as unknown as ExecutorOctokit;
        const workspaceRoot = process.env['GITHUB_WORKSPACE'] ?? process.cwd();

        const result = await executeRelease(plan, { octokit, workspaceRoot });
        if (!result.success) {
            core.setFailed(result.error ?? 'Release failed');
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.setFailed(`Tagline action crashed: ${message}`);
    }
}

void run();
