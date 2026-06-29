import type { ParsedPR, ReleaseChannel } from '@tagline-sh/shared';
import {
    RELEASE_ISSUE_LABEL,
    RELEASE_ISSUE_LABEL_COLOR,
    RELEASE_ISSUE_LABEL_DESCRIPTION,
    buildReleaseIssueClosingCommentBody,
    encodeReleaseIssueMarker,
    extractReleaseIssueMarker,
    type ReleaseIssueMarker,
} from '@tagline-sh/shared';

// Local aliases so the rest of this file keeps reading naturally. The
// `export { ... as ... }` block below also surfaces these names for
// callers that imported the bot-side aliases before the shared move.
const encodeMarker = encodeReleaseIssueMarker;
const extractMarker = extractReleaseIssueMarker;
import type { RepoRef } from '~/app/services/github-reader';

/**
 * Single-canonical-venue release UX (v0.2): the bot opens one issue per
 * release cycle, slash commands are accepted only on that issue, and the
 * issue closes when the release ships.
 *
 * This module is the bot-side, Octokit-using surface. The constants and
 * pure helpers (label name, marker codec, comment-body templates) live in
 * `@tagline-sh/shared` so the action can reuse them when closing the issue
 * during Phase B finalize.
 *
 * State is derived from GitHub on demand — no local persistence. The bot
 * recognizes "its" issue by the combination of (1) a stable label name and
 * (2) a hidden HTML-comment marker carrying a small JSON payload in the body.
 * Either alone is fragile (labels can be added by hand; HTML comments can be
 * stripped by editors); both together are reliable.
 */

// Re-export the shared constants + types for backward compatibility with
// existing bot imports (handlers, tests). The local `encodeMarker` and
// `extractMarker` aliases above are re-exported separately so both names
// remain importable from this module.
export { RELEASE_ISSUE_LABEL, encodeMarker, extractMarker, type ReleaseIssueMarker };

export interface ReleaseIssue {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    marker: ReleaseIssueMarker | null;
}

/**
 * The narrow write-side Octokit surface this module needs. Defined as a
 * single interface so handlers can pass either a Probot `context.octokit` or
 * a hand-built fake (used in tests) without leaking the full Octokit type
 * surface.
 */
export interface ReleaseIssueOctokit {
    rest: {
        issues: {
            listForRepo: (params: {
                owner: string;
                repo: string;
                labels?: string;
                state?: 'open' | 'closed' | 'all';
                per_page?: number;
            }) => Promise<{
                data: Array<{
                    number: number;
                    title: string;
                    body: string | null;
                    state: string;
                    pull_request?: unknown;
                }>;
            }>;
            create: (params: {
                owner: string;
                repo: string;
                title: string;
                body: string;
                labels?: string[];
            }) => Promise<{ data: { number: number; html_url: string } }>;
            update: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                title?: string;
                body?: string;
                state?: 'open' | 'closed';
            }) => Promise<{ data: { number: number } }>;
            createComment: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                body: string;
            }) => Promise<{ data: { id: number; html_url: string } }>;
            removeLabel: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                name: string;
            }) => Promise<unknown>;
            getLabel: (params: {
                owner: string;
                repo: string;
                name: string;
            }) => Promise<{ data: { name: string } }>;
            createLabel: (params: {
                owner: string;
                repo: string;
                name: string;
                color?: string;
                description?: string;
            }) => Promise<{ data: { name: string } }>;
        };
    };
}

// ---------------------------------------------------------------------------
// Pure rendering helpers (no Octokit; trivially testable). Marker codec lives
// in `@tagline-sh/shared` so the action can reuse it from Phase B.
// ---------------------------------------------------------------------------

export interface RenderReleaseIssueArgs {
    branch: string;
    lastTag: string | null;
    prs: ParsedPR[];
    /**
     * The release channel this issue tracks. Drives the channel tag in the
     * title (e.g. "(alpha)") so concurrent per-channel issues are visually
     * distinct. Optional for back-compat; absent → no tag (stable-style).
     */
    channel?: ReleaseChannel;
}

/** Strip the leading `type(scope?)!:` from a PR title for human-readable display. */
const CC_PREFIX_RE = /^[a-zA-Z]+(?:\([^)]*\))?!?:\s*/;
function humanizeTitle(title: string): string {
    return title.trim().replace(CC_PREFIX_RE, '').trim() || title.trim();
}

export function renderReleaseIssueTitle(args: {
    lastTag: string | null;
    prCount: number;
    channel?: ReleaseChannel;
}): string {
    const sinceClause = args.lastTag ? `since ${args.lastTag}` : 'since the first release';
    const noun = args.prCount === 1 ? 'change' : 'changes';
    // Pre-release channels get a tag so an "alpha" issue and an "rc" issue are
    // distinguishable at a glance when several run concurrently.
    const channelTag =
        args.channel && args.channel.tier === 'prerelease' && args.channel.suffix
            ? ` (${args.channel.suffix})`
            : '';
    return `🚀 Release pending${channelTag} — ${args.prCount} ${noun} ${sinceClause}`;
}

export function renderReleaseIssueBody(args: RenderReleaseIssueArgs): string {
    const marker: ReleaseIssueMarker = {
        v: 1,
        branch: args.branch,
        lastTag: args.lastTag,
    };
    const sinceClause = args.lastTag ? `since \`${args.lastTag}\`` : 'so far';

    const lines: string[] = [];
    lines.push(
        '> Tagline tracks merged PRs here until you ship the next release. Comment `/release-report` to preview the release, then `/approve` to ship.',
    );
    lines.push('');
    lines.push(`## Pending changes ${sinceClause}`);
    lines.push('');
    if (args.prs.length === 0) {
        lines.push('_No PRs merged yet — this issue will fill up as PRs land._');
    } else {
        for (const pr of args.prs) {
            lines.push(`- ${humanizeTitle(pr.title)} ([#${pr.number}](${pr.url})) — @${pr.author}`);
        }
    }
    lines.push('');
    lines.push('## Commands');
    lines.push('');
    lines.push('| Command | Effect |');
    lines.push('|---|---|');
    lines.push(
        '| `/release-report` | Preview the release: changelog, plain-language summary, suggested bump. |',
    );
    lines.push('| `/release-report --branch staging` | Preview against a non-production branch. |');
    lines.push('| `/approve` | Ship with the suggested bump. |');
    lines.push(
        '| `/approve patch \\| minor \\| major` | Force a semver bump category (semver scheme only). |',
    );
    lines.push('| `/approve as 2026.6.0` | Ship with an explicit version string. |');
    lines.push('| `/approve --draft` | Create the GitHub Release as a draft. |');
    lines.push('| `/approve --dry-run` | Simulate everything without making changes. |');
    lines.push('');
    lines.push(
        '> Slash commands only work **on this issue**. Comments on other issues or PRs are ignored.',
    );
    lines.push('');
    lines.push(encodeMarker(marker));
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Octokit-backed operations
// ---------------------------------------------------------------------------

/**
 * Find the currently-open release-tracking issue, if any. Returns `null` if
 * none exists or the candidate's marker doesn't validate.
 *
 * Looking up by label alone is not sufficient — a user could add the label
 * by hand to an unrelated issue. We additionally require the hidden marker
 * to be present and parse cleanly, which uniquely identifies a
 * bot-managed issue.
 */
export async function findOpenReleaseIssue(
    octokit: ReleaseIssueOctokit,
    repo: RepoRef,
    branch?: string,
): Promise<ReleaseIssue | null> {
    const res = await octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        labels: RELEASE_ISSUE_LABEL,
        state: 'open',
        per_page: 50,
    });
    for (const issue of res.data) {
        // `listForRepo` returns issues AND PRs in a single feed — filter out
        // PRs, which carry a `pull_request` field that issues don't.
        if (issue.pull_request) continue;
        const marker = extractMarker(issue.body);
        if (!marker) continue;
        // Per-channel scoping: when a branch is given, only match the issue that
        // tracks THAT channel (each channel branch has its own tracking issue).
        if (branch !== undefined && marker.branch !== branch) continue;
        return {
            number: issue.number,
            title: issue.title,
            body: issue.body ?? '',
            state: (issue.state as 'open' | 'closed') ?? 'open',
            marker,
        };
    }
    return null;
}

/**
 * Idempotent: ensure the `tagline:release-pending` label exists on the repo.
 * Called by `createReleaseIssue` so first-install repos don't fail on the
 * label reference. Swallows "already exists" 422s.
 */
export async function ensureReleaseLabel(
    octokit: ReleaseIssueOctokit,
    repo: RepoRef,
): Promise<void> {
    try {
        await octokit.rest.issues.getLabel({
            owner: repo.owner,
            repo: repo.repo,
            name: RELEASE_ISSUE_LABEL,
        });
        return;
    } catch (err) {
        if (!isStatusError(err, 404)) throw err;
    }
    try {
        await octokit.rest.issues.createLabel({
            owner: repo.owner,
            repo: repo.repo,
            name: RELEASE_ISSUE_LABEL,
            color: RELEASE_ISSUE_LABEL_COLOR,
            description: RELEASE_ISSUE_LABEL_DESCRIPTION,
        });
    } catch (err) {
        // Race: another concurrent merge may have created the label between
        // our 404 check and the create call. Treat 422 "already_exists" as a
        // success.
        if (!isStatusError(err, 422)) throw err;
    }
}

export type CreateReleaseIssueArgs = RenderReleaseIssueArgs;

export async function createReleaseIssue(
    octokit: ReleaseIssueOctokit,
    repo: RepoRef,
    args: CreateReleaseIssueArgs,
): Promise<{ number: number; html_url: string }> {
    await ensureReleaseLabel(octokit, repo);
    const title = renderReleaseIssueTitle({
        lastTag: args.lastTag,
        prCount: args.prs.length,
        channel: args.channel,
    });
    const body = renderReleaseIssueBody(args);
    const res = await octokit.rest.issues.create({
        owner: repo.owner,
        repo: repo.repo,
        title,
        body,
        labels: [RELEASE_ISSUE_LABEL],
    });
    return { number: res.data.number, html_url: res.data.html_url };
}

export interface UpdateReleaseIssueArgs extends RenderReleaseIssueArgs {
    issueNumber: number;
}

/**
 * Recompute and patch the issue's title + body. Idempotent: calling with the
 * same args twice produces no observable change. We deliberately re-render
 * from scratch each time rather than appending — the bot is stateless and
 * GitHub is the source of truth.
 */
export async function updateReleaseIssue(
    octokit: ReleaseIssueOctokit,
    repo: RepoRef,
    args: UpdateReleaseIssueArgs,
): Promise<void> {
    const title = renderReleaseIssueTitle({
        lastTag: args.lastTag,
        prCount: args.prs.length,
        channel: args.channel,
    });
    const body = renderReleaseIssueBody(args);
    await octokit.rest.issues.update({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: args.issueNumber,
        title,
        body,
    });
}

export interface CloseReleaseIssueArgs {
    issueNumber: number;
    tagName: string;
    releaseUrl: string;
    /** The `rawMarkdown` from `ReleaseSummary` — the "Ready to share" paste artifact. */
    readyToShareMarkdown: string;
}

/**
 * Order matters: comment first so the closing event in the issue timeline
 * sits directly after the success message. Label removal before close also
 * means a subsequent `findOpenReleaseIssue` lookup correctly returns `null`
 * even if the close hasn't propagated yet.
 */
export async function closeReleaseIssue(
    octokit: ReleaseIssueOctokit,
    repo: RepoRef,
    args: CloseReleaseIssueArgs,
): Promise<void> {
    const body = buildReleaseIssueClosingCommentBody({
        tagName: args.tagName,
        releaseUrl: args.releaseUrl,
        readyToShareMarkdown: args.readyToShareMarkdown,
    });
    await octokit.rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: args.issueNumber,
        body,
    });
    // Idempotency: removing a missing label is a 404 we swallow. Issue-close
    // is also safe to call on an already-closed issue.
    try {
        await octokit.rest.issues.removeLabel({
            owner: repo.owner,
            repo: repo.repo,
            issue_number: args.issueNumber,
            name: RELEASE_ISSUE_LABEL,
        });
    } catch (err) {
        if (!isStatusError(err, 404)) throw err;
    }
    await octokit.rest.issues.update({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: args.issueNumber,
        state: 'closed',
    });
}

/**
 * @deprecated Re-exported from `@tagline-sh/shared` as
 * `buildReleaseIssueClosingCommentBody`. Kept here under the local name for
 * existing test imports.
 */
export function buildClosingCommentBody(args: CloseReleaseIssueArgs): string {
    return buildReleaseIssueClosingCommentBody({
        tagName: args.tagName,
        releaseUrl: args.releaseUrl,
        readyToShareMarkdown: args.readyToShareMarkdown,
    });
}

function isStatusError(err: unknown, status: number): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === status
    );
}
