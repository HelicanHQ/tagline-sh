import type { BumpType } from './types.js';
import { BUMP_PRIORITY } from './constants.js';

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

/** Branch name used for the release PR. e.g. `release/v1.2.3` */
export function releaseBranchName(version: string): string {
    const stripped = version.startsWith('v') ? version.slice(1) : version;
    return `release/v${stripped}`;
}

/** Tag name written by the action. e.g. `v1.2.3` */
export function releaseTagName(version: string): string {
    return version.startsWith('v') ? version : `v${version}`;
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
