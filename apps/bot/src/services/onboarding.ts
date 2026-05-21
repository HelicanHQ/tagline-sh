import { APP_DISPLAY_NAME } from '@tagline-sh/shared';
import type { RepoRef } from '~/app/services/github-reader';
import { defaultWorkflowYaml } from '~/app/utils/comments';

/**
 * Renovate-style onboarding: when the GitHub App is installed on a repo, the
 * bot opens ONE PR titled "Configure Tagline" that adds a default
 * `.release-agent.md` and explains the release-tracking-issue UX inline (with
 * the workflow YAML embedded so the user can copy it manually).
 *
 * Design notes:
 *   - The bot ships only `.release-agent.md`, never the workflow file. Writing
 *     workflow files requires the `workflows: write` App permission, which we
 *     don't ask for in v0.2 (to minimize the install-time permissions story).
 *     The PR body includes the YAML inline as a copy-paste block; the existing
 *     `missingWorkflowComment` is the safety net if a user skips that step.
 *   - The handler is invoked for both `installation.created` (fresh install
 *     across N repos) and `installation_repositories.added` (existing install,
 *     user added more repos). The orchestrator is fully idempotent so the
 *     overlap is safe.
 *   - Idempotency rests on three checks, in this order: (1) both files already
 *     on the default branch → "already-configured", skip; (2) our PR is
 *     already open → "pr-already-open", skip; (3) our branch exists but PR
 *     isn't open (rare race) → swallow the 422 from createRef and try to open
 *     the PR anyway.
 */

export const ONBOARDING_BRANCH_NAME = 'tagline/configure';
export const ONBOARDING_CONFIG_PATH = '.release-agent.md';
export const ONBOARDING_WORKFLOW_PATH = '.github/workflows/release-agent.yml';
export const ONBOARDING_PR_TITLE = `Configure ${APP_DISPLAY_NAME}`;

// ---------------------------------------------------------------------------
// Pure rendering helpers (no Octokit)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_MARKDOWN = `# ${APP_DISPLAY_NAME} Configuration

> This file is plain Markdown. ${APP_DISPLAY_NAME} parses a few well-known
> sections; everything else is treated as free-form context for the AI prompt.

## Branches

- production: main
- staging: staging
- development: develop

## Release Notes Style

Write release notes for a technical audience. Be concise.
Group under: New Features, Bug Fixes, Maintenance.

## Scope Notes

Anything you want ${APP_DISPLAY_NAME}'s AI to remember about how this repo
ships — which packages are user-facing, which branches are pre-release, or
rules about what should never go into a customer-visible changelog.
`;

export function renderDefaultReleaseAgentConfig(): string {
    return DEFAULT_CONFIG_MARKDOWN;
}

export interface RenderOnboardingPRBodyArgs {
    workflowYaml: string;
}

export function renderOnboardingPRBody(args: RenderOnboardingPRBodyArgs): string {
    const lines: string[] = [];
    lines.push(`Thanks for installing **${APP_DISPLAY_NAME}**! 👋`);
    lines.push('');
    lines.push(
        `This PR adds a default \`${ONBOARDING_CONFIG_PATH}\` so ${APP_DISPLAY_NAME} has somewhere to look for your branch + release-notes-tone preferences. Edit it freely before merging — every section is optional.`,
    );
    lines.push('');
    lines.push('## One more thing — add the release workflow');
    lines.push('');
    lines.push(
        `${APP_DISPLAY_NAME} writes nothing to your repo directly. The release work runs inside your own CI via a GitHub Action. Add this file to your repo at \`${ONBOARDING_WORKFLOW_PATH}\`:`,
    );
    lines.push('');
    lines.push('```yaml');
    lines.push(args.workflowYaml);
    lines.push('```');
    lines.push('');
    lines.push('## How the release flow works');
    lines.push('');
    lines.push(
        `Once the workflow is in place, ${APP_DISPLAY_NAME} watches PRs merged into your production branch. When the first PR after a release lands, it opens a **release-tracking issue** labeled \`tagline:release-pending\` and keeps it up to date as more PRs merge.`,
    );
    lines.push('');
    lines.push('That issue is the only place slash commands work:');
    lines.push('');
    lines.push(
        '- `/release-report` — preview the release (changelog + plain-language summary + suggested bump)',
    );
    lines.push('- `/approve` — ship it');
    lines.push('');
    lines.push(
        'Comments on any other issue or PR are silently ignored, so the bot stays quiet on unrelated conversations.',
    );
    lines.push('');
    lines.push('## Checklist');
    lines.push('');
    lines.push(`- [ ] Review (or edit) \`${ONBOARDING_CONFIG_PATH}\`.`);
    lines.push(`- [ ] Add \`${ONBOARDING_WORKFLOW_PATH}\` with the YAML above.`);
    lines.push('- [ ] Add an `AI_API_KEY` repository secret (any OpenAI-compatible provider).');
    lines.push('- [ ] Merge this PR.');
    lines.push('');
    lines.push('Questions? See the [docs](https://github.com/tagline-sh/tagline-sh).');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Octokit-backed orchestration
// ---------------------------------------------------------------------------

/**
 * Narrow write-side Octokit surface used by `ensureOnboardingPR`. Handlers
 * pass either a Probot `context.octokit` or a hand-built fake; the type
 * surface stays small and audit-able.
 */
export interface OnboardingOctokit {
    rest: {
        repos: {
            get: (params: {
                owner: string;
                repo: string;
            }) => Promise<{ data: { default_branch: string } }>;
            getContent: (params: {
                owner: string;
                repo: string;
                path: string;
                ref?: string;
            }) => Promise<unknown>;
            createOrUpdateFileContents: (params: {
                owner: string;
                repo: string;
                path: string;
                message: string;
                content: string;
                branch?: string;
                sha?: string;
            }) => Promise<{ data: { commit: { sha: string | null } } }>;
        };
        git: {
            getRef: (params: {
                owner: string;
                repo: string;
                ref: string;
            }) => Promise<{ data: { object: { sha: string } } }>;
            createRef: (params: {
                owner: string;
                repo: string;
                ref: string;
                sha: string;
            }) => Promise<unknown>;
        };
        pulls: {
            list: (params: {
                owner: string;
                repo: string;
                state?: 'open' | 'closed' | 'all';
                head?: string;
                per_page?: number;
            }) => Promise<{
                data: Array<{
                    number: number;
                    html_url: string;
                    head: { ref: string };
                }>;
            }>;
            create: (params: {
                owner: string;
                repo: string;
                title: string;
                body: string;
                head: string;
                base: string;
            }) => Promise<{ data: { number: number; html_url: string } }>;
        };
    };
}

/**
 * Check whether a file exists at `path` on the given `ref`. Returns `false`
 * on a 404 (not present), `true` otherwise. Any other error propagates — a
 * permission error here should fail the onboarding loudly so the install
 * shows red instead of pretending to succeed.
 */
async function fileExists(
    octokit: OnboardingOctokit,
    repo: RepoRef,
    ref: string,
    path: string,
): Promise<boolean> {
    try {
        await octokit.rest.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path,
            ref,
        });
        return true;
    } catch (err) {
        if (isStatusError(err, 404)) return false;
        throw err;
    }
}

/**
 * Look for an open PR whose head ref is our onboarding branch. The `head`
 * filter on `pulls.list` is `owner:branch`, so we filter client-side to
 * avoid having to know the App's bot owner here.
 */
export async function findExistingOnboardingPR(
    octokit: OnboardingOctokit,
    repo: RepoRef,
): Promise<{ number: number; html_url: string } | null> {
    const res = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: 'open',
        per_page: 100,
    });
    for (const pr of res.data) {
        if (pr.head.ref === ONBOARDING_BRANCH_NAME) {
            return { number: pr.number, html_url: pr.html_url };
        }
    }
    return null;
}

export type EnsureOnboardingResult =
    | { kind: 'skipped'; reason: 'already-configured' | 'pr-already-open' }
    | { kind: 'created'; prNumber: number; prUrl: string };

/**
 * Idempotent end-to-end orchestrator. Safe to call multiple times for the
 * same repo (per-event-replay, per-install-add, per-restart).
 */
export async function ensureOnboardingPR(
    octokit: OnboardingOctokit,
    repo: RepoRef,
): Promise<EnsureOnboardingResult> {
    const { data: repoInfo } = await octokit.rest.repos.get({
        owner: repo.owner,
        repo: repo.repo,
    });
    const defaultBranch = repoInfo.default_branch;

    const [configExists, workflowExists] = await Promise.all([
        fileExists(octokit, repo, defaultBranch, ONBOARDING_CONFIG_PATH),
        fileExists(octokit, repo, defaultBranch, ONBOARDING_WORKFLOW_PATH),
    ]);
    if (configExists && workflowExists) {
        return { kind: 'skipped', reason: 'already-configured' };
    }

    const existing = await findExistingOnboardingPR(octokit, repo);
    if (existing) {
        return { kind: 'skipped', reason: 'pr-already-open' };
    }

    const { data: ref } = await octokit.rest.git.getRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${defaultBranch}`,
    });
    const baseSha = ref.object.sha;

    // Branch may already exist from a prior partial run — treat 422 as
    // "fine, keep going" and let the PR-open step (or the file commit) reuse
    // whatever's on the branch.
    try {
        await octokit.rest.git.createRef({
            owner: repo.owner,
            repo: repo.repo,
            ref: `refs/heads/${ONBOARDING_BRANCH_NAME}`,
            sha: baseSha,
        });
    } catch (err) {
        if (!isStatusError(err, 422)) throw err;
    }

    if (!configExists) {
        await octokit.rest.repos.createOrUpdateFileContents({
            owner: repo.owner,
            repo: repo.repo,
            path: ONBOARDING_CONFIG_PATH,
            message: `Add default ${ONBOARDING_CONFIG_PATH}`,
            content: Buffer.from(renderDefaultReleaseAgentConfig(), 'utf-8').toString('base64'),
            branch: ONBOARDING_BRANCH_NAME,
        });
    }

    const body = renderOnboardingPRBody({ workflowYaml: defaultWorkflowYaml() });
    const { data: pr } = await octokit.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        title: ONBOARDING_PR_TITLE,
        body,
        head: ONBOARDING_BRANCH_NAME,
        base: defaultBranch,
    });

    return { kind: 'created', prNumber: pr.number, prUrl: pr.html_url };
}

function isStatusError(err: unknown, status: number): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === status
    );
}
