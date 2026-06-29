import type { ParsedPR } from '@tagline-sh/shared';
import type { Context, Probot } from 'probot';
import { channelForBranch, getPRsSinceLastTag, readRepoConfig } from '~/app/services';
import { OctokitGitHubReader, type ReaderOctokit } from '~/app/services/octokit-reader';
import type { GitHubReader, PullRequestSummary, RepoRef } from '~/app/services/github-reader';
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
    | { kind: 'skipped'; reason: 'not-merged' | 'release-branch' | 'non-channel' | 'no-prs' }
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
        // Carried from the webhook payload so we can seed the just-merged PR
        // directly instead of waiting for the Search API to index it. See
        // `manageReleaseIssue` for why.
        title: string;
        url: string;
        author: string;
        mergedAt: string;
        body: string | null;
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
 *   - Base ref is not a configured release channel → skip ('non-channel').
 *     Each channel branch (stable/staging/dev) gets its OWN tracking issue.
 *   - Issue already exists → re-render and update.
 *   - Issue doesn't exist → create with the current pending-PR list.
 *
 * The pending-PR list is the union of (a) the PR that triggered this webhook,
 * taken straight from the event payload, and (b) `getPRsSinceLastTag`, which
 * queries the GitHub Search API. (b) lags a few seconds behind a fresh merge,
 * so on the merge that *should* open the issue the just-merged PR is routinely
 * missing from the search results — which previously produced a spurious
 * 'no-prs' skip and no issue at all on low-traffic repos. Seeding the
 * triggering PR from the payload makes a qualifying merge always open/refresh
 * the issue; the search results backfill any earlier PRs since the last tag.
 * ('no-prs' therefore can't occur for a qualifying merge anymore; the guard
 * remains as defence in depth.)
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
    const channel = channelForBranch(config, input.pr.baseRef);
    if (!channel) {
        return { kind: 'skipped', reason: 'non-channel' };
    }

    const { prs: searchResults, lastTag } = await getPRsSinceLastTag(
        deps.reader,
        input.repo,
        channel.branch,
    );

    // Seed the triggering PR from the webhook payload. It has already passed
    // the merged / non-release-branch / production-base guards above, so it
    // belongs in the list — but the Search API behind `getPRsSinceLastTag` may
    // not have indexed it yet. Union by number (search wins on dup, since it
    // carries the canonical record), appending the payload PR if absent.
    const triggeringPR: PullRequestSummary = {
        number: input.pr.number,
        title: input.pr.title,
        body: input.pr.body,
        url: input.pr.url,
        author: input.pr.author,
        mergedAt: input.pr.mergedAt,
        baseRef: input.pr.baseRef,
        headRef: input.pr.headRef,
    };
    const summaries = searchResults.some((p) => p.number === triggeringPR.number)
        ? searchResults
        : [...searchResults, triggeringPR];

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

    const existing = await findOpenReleaseIssue(deps.octokit, input.repo, channel.branch);
    if (existing) {
        await updateReleaseIssue(deps.octokit, input.repo, {
            issueNumber: existing.number,
            branch: channel.branch,
            channel,
            lastTag: lastTag?.name ?? null,
            prs,
        });
        return { kind: 'updated', issueNumber: existing.number };
    }
    const created = await createReleaseIssue(deps.octokit, input.repo, {
        branch: channel.branch,
        channel,
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
                    title: pr.title,
                    url: pr.html_url,
                    author: pr.user?.login ?? 'unknown',
                    mergedAt: pr.merged_at ?? '',
                    body: pr.body ?? null,
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
        context.log.error({ err, repo, pr: pr.number }, 'Failed to manage release-tracking issue');
    }
}

export function register(app: Probot): void {
    app.on('pull_request.closed', handlePullRequestClosed);
}
