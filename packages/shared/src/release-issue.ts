/**
 * Release-tracking-issue primitives shared between the bot and the action.
 *
 * The bot opens and updates the release issue on PR merges (see
 * `apps/bot/src/handlers/pull-request.ts`); the action closes it during
 * Phase B finalize after the release ships. Both ends agree on the label
 * name, the marker shape, the closing comment body, and the parser — those
 * live here so neither side can drift independently.
 *
 * This module deliberately has no Octokit / network dependencies. Each app
 * brings its own write-side Octokit (different shapes) and uses these pure
 * helpers to format payloads and identify Tagline-managed issues.
 */

/** Label every Tagline release-tracking issue carries. */
export const RELEASE_ISSUE_LABEL = 'tagline:release-pending';

/**
 * 6-char hex color (no leading `#`) used when creating the label. Mid-green
 * — matches GitHub's "ready / pending" semantic palette without colliding
 * with the standard `enhancement` and `bug` palette anchors.
 */
export const RELEASE_ISSUE_LABEL_COLOR = '0E8A16'; // green
export const RELEASE_ISSUE_LABEL_DESCRIPTION =
    'Tagline tracks merged PRs in this issue until the next release ships.';

/**
 * HTML-comment tokens that wrap the JSON marker inside the issue body. The
 * bot writes this marker on issue create/update; both ends use it as the
 * second factor (alongside the label) to identify "their" issue.
 */
export const RELEASE_ISSUE_MARKER_START = '<!-- tagline-issue-v1';
export const RELEASE_ISSUE_MARKER_END = '-->';

export interface ReleaseIssueMarker {
    /** Schema version. Bump when the marker JSON shape changes incompatibly. */
    v: 1;
    /** Production branch this issue tracks (the one we watch for merges). */
    branch: string;
    /** Last release tag at issue-open time. Informational; recomputed at render time. */
    lastTag: string | null;
}

export function encodeReleaseIssueMarker(marker: ReleaseIssueMarker): string {
    // Plain JSON inside the HTML comment. Marker is tiny (~80 chars) so
    // base64 buys nothing; a JSON-shaped marker is also easier to debug
    // from the GitHub UI by anyone reading raw issue source.
    return `${RELEASE_ISSUE_MARKER_START} ${JSON.stringify(marker)} ${RELEASE_ISSUE_MARKER_END}`;
}

/**
 * Pull the Tagline marker out of an issue body, if present. Returns `null`
 * for any failure mode (no marker, malformed JSON, unsupported version).
 * Callers treat `null` as "this is not a Tagline-managed issue."
 */
export function extractReleaseIssueMarker(
    body: string | null | undefined,
): ReleaseIssueMarker | null {
    if (!body) return null;
    const start = body.indexOf(RELEASE_ISSUE_MARKER_START);
    if (start === -1) return null;
    const after = start + RELEASE_ISSUE_MARKER_START.length;
    const end = body.indexOf(RELEASE_ISSUE_MARKER_END, after);
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

export interface ClosingCommentArgs {
    tagName: string;
    releaseUrl: string;
    /** The `rawMarkdown` from `ReleaseSummary` — the "Ready to share" paste artifact. */
    readyToShareMarkdown: string;
}

/**
 * Build the "Released! 🎉" comment body posted on the release issue when
 * Phase B finalizes. The body is rendered identically whether the close is
 * single-repo or monorepo — `tagName` becomes the primary tag in the
 * single-repo case and a representative event identifier in the monorepo
 * case; the per-tag release URLs are documented separately.
 */
export function buildReleaseIssueClosingCommentBody(args: ClosingCommentArgs): string {
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

export interface MonorepoClosingCommentArgs {
    /** One entry per tag; same length and order as `tags`. */
    tags: string[];
    /** Release URLs aligned with `tags`. Missing entries mean "release not created" (idempotency). */
    releaseUrls: Array<string | null>;
    readyToShareMarkdown: string;
}

/**
 * Variant of `buildReleaseIssueClosingCommentBody` for monorepo releases —
 * lists every tag→release-URL pair instead of a single one. Shared between
 * bot and action so the rendering stays byte-identical.
 */
export function buildReleaseIssueMonorepoClosingCommentBody(
    args: MonorepoClosingCommentArgs,
): string {
    const lines: string[] = [];
    lines.push(`Released ${args.tags.length} packages 🎉`);
    lines.push('');
    for (let i = 0; i < args.tags.length; i += 1) {
        const url = args.releaseUrls[i];
        if (url) {
            lines.push(`- \`${args.tags[i]}\` → ${url}`);
        } else {
            lines.push(`- \`${args.tags[i]}\` (already released, skipped)`);
        }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Ready to share:**');
    lines.push('');
    lines.push(args.readyToShareMarkdown.trimEnd());
    return lines.join('\n');
}
