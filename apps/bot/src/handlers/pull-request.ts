import type { ParsedPR } from '@tagline-sh/shared';
import type { Context, Probot } from 'probot';
import { getPRsSinceLastTag, readRepoConfig } from '~/app/services';
import { OctokitGitHubReader, type ReaderOctokit } from '~/app/services/octokit-reader';
import type { GitHubReader, RepoRef } from '~/app/services/github-reader';
import {
    createReleaseIssue,
    findOpenReleaseIssue,
    updateReleaseIssue,
    type ReleaseIssueOctokit,
} from '~/app/services/release-issue';

// See note in handlers/issue-comment.ts on the Octokit type adapter.
const asReader = (octokit: Context['octokit']): ReaderOctokit =>
    octokit as unknown as ReaderOctokit;
const asReleaseIssue = (octokit: Context['octokit']): ReleaseIssueOctokit =>
    octokit as unknown as ReleaseIssueOctokit;

/**
 * Outcome of a release-issue management run. Surfaced for tests and the
 * Probot handler's logging; not part of the user-facing UX.
 */
export type ManageReleaseIssueOutcome =
    | { kind: 'skipped'; reason: 'not-merged' | 'release-branch' | 'non-production' | 'no-prs' }
    | { kind: 'created'; issueNumber: number }
    | { kind: 'updated'; issueNumber: number };

export interface ManageReleaseIssueDeps {
    reader: GitHubReader;
    octokit: ReleaseIssueOctokit;
}

export interface ManageReleaseIssueInput {
    repo: RepoRef;
    pr: {
        number: number;
        merged: boolean;
        baseRef: string;
        headRef: string;
    };
}

/**
 * Pure-ish core for the PR-merged → release-issue lifecycle. Reads repo
 * config + pending-PR list via `deps.reader`, ensures the canonical
 * release-tracking issue reflects the current state via `deps.octokit`.
 *
 * Returns an outcome so callers can log appropriately (and tests can
 * assert behavior without mocking the Probot Context surface).
 *
 * Behavior contract:
 *   - Not merged → skip ('not-merged').
 *   - Head ref starts with `release/` → skip ('release-branch'); Phase B
 *     closes the release issue itself in that case.
 *   - Base ref is not the configured production branch → skip
 *     ('non-production'); staging/dev are user-driven only.
 *   - `listMergedPRs` returns nothing (eventual-consistency lag) → skip
 *     ('no-prs'); next merge will repair.
 *   - Issue already exists → re-render and update.
 *   - Issue doesn't exist → create with the current pending-PR list.
 */
export async function manageReleaseIssue(
    input: ManageReleaseIssueInput,
    deps: ManageReleaseIssueDeps,
): Promise<ManageReleaseIssueOutcome> {
    if (!input.pr.merged) return { kind: 'skipped', reason: 'not-merged' };
    if (input.pr.headRef.startsWith('release/')) {
        return { kind: 'skipped', reason: 'release-branch' };
    }

    const config = await readRepoConfig(deps.reader, input.repo);
    if (input.pr.baseRef !== config.branches.production) {
        return { kind: 'skipped', reason: 'non-production' };
    }

    const { prs: summaries, lastTag } = await getPRsSinceLastTag(
        deps.reader,
        input.repo,
        config.branches.production,
    );
    if (summaries.length === 0) {
        return { kind: 'skipped', reason: 'no-prs' };
    }

    // The release-issue body only uses title/number/url/author. Synthesize
    // minimal `ParsedPR` records without paying for per-PR commit hydration
    // here — the report path does its own hydration when needed.
    const prs: ParsedPR[] = summaries.map((s) => ({
        number: s.number,
        title: s.title,
        url: s.url,
        author: s.author,
        mergedAt: s.mergedAt,
        commits: [],
        tickets: [],
        suggestedBump: 'none',
        bodyExcerpt: null,
    }));

    const existing = await findOpenReleaseIssue(deps.octokit, input.repo);
    if (existing) {
        await updateReleaseIssue(deps.octokit, input.repo, {
            issueNumber: existing.number,
            branch: config.branches.production,
            lastTag: lastTag?.name ?? null,
            prs,
        });
        return { kind: 'updated', issueNumber: existing.number };
    }
    const created = await createReleaseIssue(deps.octokit, input.repo, {
        branch: config.branches.production,
        lastTag: lastTag?.name ?? null,
        prs,
    });
    return { kind: 'created', issueNumber: created.number };
}

/**
 * Probot webhook adapter for `pull_request.closed`. Constructs the reader +
 * release-issue Octokit views over `context.octokit`, then delegates to the
 * pure `manageReleaseIssue` core.
 *
 * The handler swallows errors and logs them — a release-issue update
 * failure must NOT crash the webhook handler or surface red to the user.
 * The next PR merge will repair the state.
 */
export async function handlePullRequestClosed(
    context: Context<'pull_request.closed'>,
): Promise<void> {
    const pr = context.payload.pull_request;
    const repo = context.repo();

    try {
        const outcome = await manageReleaseIssue(
            {
                repo,
                pr: {
                    number: pr.number,
                    merged: pr.merged,
                    baseRef: pr.base.ref,
                    headRef: pr.head.ref,
                },
            },
            {
                reader: new OctokitGitHubReader(asReader(context.octokit)),
                octokit: asReleaseIssue(context.octokit),
            },
        );

        switch (outcome.kind) {
            case 'created':
                context.log.info(
                    { repo, pr: pr.number, issue: outcome.issueNumber },
                    'Opened release-tracking issue',
                );
                return;
            case 'updated':
                context.log.info(
                    { repo, pr: pr.number, issue: outcome.issueNumber },
                    'Updated release-tracking issue',
                );
                return;
            case 'skipped':
                context.log.info(
                    { repo, pr: pr.number, reason: outcome.reason },
                    'Release-issue management skipped',
                );
                return;
        }
    } catch (err) {
        context.log.error(
            { err, repo, pr: pr.number },
            'Failed to manage release-tracking issue',
        );
    }
}

export function register(app: Probot): void {
    app.on('pull_request.closed', handlePullRequestClosed);
}
