import type { ParsedPR } from '@tagline-sh/shared';
import type { RepoRef } from '~/app/services/github-reader';

/**
 * Single-canonical-venue release UX (v0.2): the bot opens one issue per
 * release cycle, slash commands are accepted only on that issue, and the
 * issue closes when the release ships.
 *
 * This module is pure helpers + a narrow write-side Octokit interface. The
 * webhook handler (Milestone B) wires it to Probot's `pull_request.closed`
 * events; the action's Phase B completion step (Milestone C) calls
 * `closeReleaseIssue` via the same Octokit.
 *
 * State is derived from GitHub on demand — no local persistence. The bot
 * recognizes "its" issue by the combination of (1) a stable label name and
 * (2) a hidden HTML-comment marker carrying a small JSON payload in the body.
 * Either alone is fragile (labels can be added by hand; HTML comments can be
 * stripped by editors); both together are reliable.
 */

/** Label every Tagline release-tracking issue carries. */
export const RELEASE_ISSUE_LABEL = 'tagline:release-pending';

/**
 * Color of the label, in 6-char hex without leading `#`. Mid-blue, matches
 * the Action's planned Marketplace branding.
 */
const RELEASE_ISSUE_LABEL_COLOR = '0E8A16';
const RELEASE_ISSUE_LABEL_DESCRIPTION =
    'Tagline tracks merged PRs in this issue until the next release ships.';

const MARKER_START = '<!-- tagline-issue-v1';
const MARKER_END = '-->';

export interface ReleaseIssueMarker {
    /** Schema version. Bump when the marker JSON shape changes incompatibly. */
    v: 1;
    /** Production branch this issue tracks (the one we watch for merges). */
    branch: string;
    /** Last release tag at issue-open time. Informational; recomputed at render time. */
    lastTag: string | null;
}

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
// Pure rendering + marker helpers (no Octokit; trivially testable)
// ---------------------------------------------------------------------------

export function encodeMarker(marker: ReleaseIssueMarker): string {
    // Plain JSON inside the HTML comment. The marker is tiny (~80 chars) so
    // base64 buys nothing; a JSON-shaped marker is also easier to debug from
    // the GitHub UI by anyone reading raw issue source.
    return `${MARKER_START} ${JSON.stringify(marker)} ${MARKER_END}`;
}

/**
 * Pull the Tagline marker out of an issue body, if present. Returns `null`
 * for any failure mode (no marker, malformed JSON, unsupported version).
 * Callers treat `null` as "this is not a Tagline issue."
 */
export function extractMarker(body: string | null | undefined): ReleaseIssueMarker | null {
    if (!body) return null;
    const start = body.indexOf(MARKER_START);
    if (start === -1) return null;
    const after = start + MARKER_START.length;
    const end = body.indexOf(MARKER_END, after);
    if (end === -1) return null;
    const json = body.slice(after, end).trim();
    try {
        const parsed = JSON.parse(json) as unknown;
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            (parsed as { v?: unknown }).v !== 1 ||
            typeof (parsed as { branch?: unknown }).branch !== 'string'
        ) {
            return null;
        }
        const marker = parsed as ReleaseIssueMarker;
        return {
            v: 1,
            branch: marker.branch,
            lastTag: marker.lastTag ?? null,
        };
    } catch {
        return null;
    }
}

export interface RenderReleaseIssueArgs {
    branch: string;
    lastTag: string | null;
    prs: ParsedPR[];
}

/** Strip the leading `type(scope?)!:` from a PR title for human-readable display. */
const CC_PREFIX_RE = /^[a-zA-Z]+(?:\([^)]*\))?!?:\s*/;
function humanizeTitle(title: string): string {
    return title.trim().replace(CC_PREFIX_RE, '').trim() || title.trim();
}

export function renderReleaseIssueTitle(args: { lastTag: string | null; prCount: number }): string {
    const sinceClause = args.lastTag ? `since ${args.lastTag}` : 'since the first release';
    const noun = args.prCount === 1 ? 'change' : 'changes';
    return `🚀 Release pending — ${args.prCount} ${noun} ${sinceClause}`;
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
    lines.push('| `/release-report` | Preview the release: changelog, plain-language summary, suggested bump. |');
    lines.push('| `/release-report --branch staging` | Preview against a non-production branch. |');
    lines.push('| `/approve` | Ship with the suggested bump. |');
    lines.push('| `/approve patch \\| minor \\| major` | Force a semver bump category (semver scheme only). |');
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
    const title = renderReleaseIssueTitle({ lastTag: args.lastTag, prCount: args.prs.length });
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
    const title = renderReleaseIssueTitle({ lastTag: args.lastTag, prCount: args.prs.length });
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
 * Phase B completion path. Posts a "Released!" comment with the release URL
 * and the plain-language summary, removes the label, then closes the issue.
 *
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
    const body = buildClosingCommentBody(args);
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

export function buildClosingCommentBody(args: CloseReleaseIssueArgs): string {
    const lines: string[] = [];
    lines.push(`Released \`${args.tagName}\` 🎉`);
    lines.push('');
    lines.push(`Release: ${args.releaseUrl}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Ready to share:**');
    lines.push('');
    lines.push(args.readyToShareMarkdown.trimEnd());
    return lines.join('\n');
}

function isStatusError(err: unknown, status: number): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === status
    );
}
