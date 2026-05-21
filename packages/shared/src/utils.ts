import type { BumpType, ReleaseSummary } from './types';
import { BUMP_PRIORITY } from './constants';

/**
 * Extract ticket references from text.
 *
 * Matches three families (PLAN.md §11):
 *   - JIRA / Linear style: `PROJ-123`, `ENG-456` (uppercase prefix)
 *   - Linear lowercase variant: `eng-123` (case-insensitive prefix)
 *   - GitHub Issues: `#42`
 *
 * The order matters: we run JIRA first (uppercase) so `PROJ-123` is captured as
 * `PROJ-123` rather than being matched twice. Results are deduplicated while
 * preserving first-occurrence order.
 *
 * No external API calls — pure regex on the supplied text.
 */
export function extractTickets(text: string): string[] {
    if (!text) return [];

    const seen = new Set<string>();
    const out: string[] = [];

    const push = (raw: string): void => {
        const normalized = raw.trim();
        if (!normalized) return;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        out.push(normalized);
    };

    // GitHub-issue references first so `#42` always wins over partial matches.
    const ghRe = /#\d+/g;
    for (const match of text.matchAll(ghRe)) push(match[0]);

    // JIRA/Linear style: 2+ alphanumerics + hyphen + digits. Case-insensitive but
    // we keep the original case to honor the project's convention.
    const projRe = /\b[A-Za-z][A-Za-z0-9]+-\d+\b/g;
    for (const match of text.matchAll(projRe)) push(match[0]);

    return out;
}

/**
 * Prefix every release branch shares (`release/v…`). Used by readers that need
 * to recognize bot-authored release PRs without depending on a specific version
 * string.
 */
export const RELEASE_BRANCH_PREFIX = 'release/v';

/** Branch name used for the release PR. e.g. `release/v1.2.3` */
export function releaseBranchName(version: string): string {
    const stripped = version.startsWith('v') ? version.slice(1) : version;
    return `${RELEASE_BRANCH_PREFIX}${stripped}`;
}

/**
 * Returns true if `headRef` looks like one of our own release branches
 * (`release/v1.2.3`, `release/v2026.05.0-rc.0`, etc.). Used to filter the
 * previous release PR out of the next release's changelog — its body is the
 * old changelog and would otherwise leak hundreds of `#N` refs as tickets.
 */
export function isReleaseBranch(headRef: string): boolean {
    return headRef.startsWith(RELEASE_BRANCH_PREFIX);
}

/** Tag name written by the action. e.g. `v1.2.3` */
export function releaseTagName(version: string): string {
    return version.startsWith('v') ? version : `v${version}`;
}

/**
 * Per-package tag name (M3 — monorepo per-package versioning), following
 * Changesets convention:
 *
 *   - Scoped:   `@acme/api` + `1.5.0` → `@acme/api@1.5.0`
 *   - Unscoped: `api`       + `1.5.0` → `api@1.5.0`
 *
 * Leading `v` on the version is stripped first so callers can pass either
 * `1.5.0` or `v1.5.0` and get the same canonical output. Recognizable to
 * anyone who's used Changesets / Lerna — staying with the convention earns
 * familiarity for free.
 */
export function packageTagName(packageName: string, version: string): string {
    const stripped = version.startsWith('v') ? version.slice(1) : version;
    return `${packageName}@${stripped}`;
}

/** Returns the higher-impact of two bumps. `major > minor > patch > none`. */
export function maxBump(a: BumpType, b: BumpType): BumpType {
    return BUMP_PRIORITY[a] >= BUMP_PRIORITY[b] ? a : b;
}

/** Folds an array of bumps to the highest impact present. */
export function aggregateBumps(bumps: readonly BumpType[]): BumpType {
    let acc: BumpType = 'none';
    for (const b of bumps) acc = maxBump(acc, b);
    return acc;
}

/** Truncate a PR body to the first N chars (default 500) preserving word boundaries. */
export function excerpt(text: string | null | undefined, maxLen = 500): string | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.length <= maxLen) return trimmed;
    const slice = trimmed.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(' ');
    return (lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice) + '…';
}

/**
 * Format a `ReleaseSummary` as Markdown ready to paste into Slack, email,
 * Beamer, or any external channel. This is the canonical `rawMarkdown` shape
 * used by both apps (bot for the report-comment preview, action for the GitHub
 * release body and "Ready to share" block in the completion comment) — keeping
 * the renderer in `packages/shared` ensures bot and action produce byte-equal
 * output for the same summary.
 *
 * Output convention (PLAN_ADDENDUM.md §5):
 *
 *     ## What's new in v1.5.0 · May 18, 2026
 *
 *     {headline}
 *
 *     {body}
 *
 *     - {highlight 1}
 *     - {highlight 2}
 */
export function buildSummaryMarkdown(summary: ReleaseSummary): string {
    const version = summary.version.startsWith('v') ? summary.version : `v${summary.version}`;
    return [
        `## What's new in ${version} · ${summary.date}`,
        '',
        summary.headline,
        '',
        summary.body,
        '',
        summary.highlights.map((h) => `- ${h}`).join('\n'),
    ].join('\n');
}

/**
 * Format a `Date` as `"May 18, 2026"` in UTC, matching the convention used by
 * `ReleaseSummary.date`. UTC for bot/action parity — both should produce the
 * same `date` string for the same instant regardless of where they run.
 */
export function formatSummaryDate(d: Date): string {
    return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
    });
}

/**
 * Re-stamp a previewed `ReleaseSummary` with the actual release version + now.
 *
 * Used when `/approve` is issued: the report comment may have previewed
 * `v1.5.0` on Monday, but the user runs `/approve major` on Thursday so the
 * actual release is `v2.0.0` and the date is Thursday. The AI's prose
 * (`headline`, `body`, `highlights`) is what the user approved — keep that —
 * but `version`, `date`, and the derived `rawMarkdown` must reflect ground
 * truth at release time.
 */
export function restampSummary(
    summary: ReleaseSummary,
    version: string,
    now: Date,
): ReleaseSummary {
    const versionLabel = version.startsWith('v') ? version.slice(1) : version;
    const intermediate: ReleaseSummary = {
        ...summary,
        version: versionLabel,
        date: formatSummaryDate(now),
        rawMarkdown: '',
    };
    return { ...intermediate, rawMarkdown: buildSummaryMarkdown(intermediate) };
}
