import type { ParsedPR } from '@tagline-sh/shared';

// Keep-a-Changelog section order (PLAN.md §15). We support these section types;
// anything outside them gets folded into "Changed".
type SectionKind = 'Added' | 'Fixed' | 'Changed' | 'Removed';

const TYPE_TO_SECTION: Record<string, SectionKind> = {
    feat: 'Added',
    fix: 'Fixed',
    perf: 'Changed',
    refactor: 'Changed',
    revert: 'Changed',
    docs: 'Changed',
    style: 'Changed',
    build: 'Changed',
    ci: 'Changed',
    chore: 'Changed',
    test: 'Changed',
    breaking: 'Removed',
    hotfix: 'Fixed',
    release: 'Changed',
};

/** ISO-date (`YYYY-MM-DD`) helper — used in the section header. */
function isoDate(d: Date): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/** Pick the most informative subject for a PR: first feat/fix subject if any, else the PR title. */
function bestSubject(pr: ParsedPR): string {
    const interesting = pr.commits.find((c) => c.type === 'feat' || c.type === 'fix');
    if (interesting) return interesting.subject;
    const first = pr.commits[0];
    return first?.subject ?? pr.title;
}

function ticketSuffix(pr: ParsedPR): string {
    if (pr.tickets.length === 0) return '';
    return ' · ' + pr.tickets.join(', ');
}

function bulletForPR(pr: ParsedPR): string {
    const subject = bestSubject(pr);
    return `- ${subject} ([#${pr.number}](${pr.url}))${ticketSuffix(pr)}`;
}

/** Pick the most appropriate section for a PR based on its dominant commit type. */
function sectionForPR(pr: ParsedPR): SectionKind {
    if (pr.commits.some((c) => c.isBreaking)) return 'Removed';
    if (pr.commits.some((c) => c.type === 'feat')) return 'Added';
    if (pr.commits.some((c) => c.type === 'fix')) return 'Fixed';
    const first = pr.commits[0];
    return first ? (TYPE_TO_SECTION[first.type] ?? 'Changed') : 'Changed';
}

export interface ChangelogEntryInput {
    version: string;
    /** ISO date string (`YYYY-MM-DD`) or undefined for "today". */
    date?: string;
    prs: ParsedPR[];
}

/**
 * Render a Keep-a-Changelog entry as a Markdown string.
 *
 * Output shape (PLAN.md §15):
 *
 *     ## [1.5.0] - 2026-05-18
 *
 *     ### Added
 *
 *     - OAuth2 PKCE support ([#342](url)) · PROJ-1201
 *
 *     ### Fixed
 *
 *     - Token refresh race condition ([#341](url))
 *
 * Empty sections are omitted.
 */
export function renderChangelogEntry(input: ChangelogEntryInput): string {
    const date = input.date ?? isoDate(new Date());
    const version = input.version.startsWith('v') ? input.version.slice(1) : input.version;

    const buckets: Record<SectionKind, string[]> = {
        Added: [],
        Fixed: [],
        Changed: [],
        Removed: [],
    };

    for (const pr of input.prs) {
        const section = sectionForPR(pr);
        buckets[section].push(bulletForPR(pr));
    }

    const lines: string[] = [`## [${version}] - ${date}`];

    for (const section of ['Added', 'Fixed', 'Changed', 'Removed'] as const) {
        const items = buckets[section];
        if (items.length === 0) continue;
        lines.push('', `### ${section}`, '', ...items);
    }

    return lines.join('\n') + '\n';
}

const CHANGELOG_HEADER = [
    '# Changelog',
    '',
    'All notable changes to this project are documented in this file.',
    '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
    'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
    '',
].join('\n');

/**
 * Prepend a new entry to an existing CHANGELOG.md (or create one).
 *
 * Strategy: locate the first `## [` line in the existing file and insert the
 * new entry directly above it. If there isn't one, append after the standard
 * header. If the file is missing entirely, generate it from scratch.
 */
export function prependEntryToChangelog(existing: string | null, newEntry: string): string {
    const entry = newEntry.trim() + '\n';

    if (!existing || existing.trim() === '') {
        return `${CHANGELOG_HEADER}\n${entry}`;
    }

    const lines = existing.split('\n');
    const firstEntryIdx = lines.findIndex((l) => /^## \[/.test(l));

    if (firstEntryIdx === -1) {
        // No prior entries — just append.
        const trimmed = existing.replace(/\s+$/, '');
        return `${trimmed}\n\n${entry}`;
    }

    const before = lines.slice(0, firstEntryIdx).join('\n').replace(/\s+$/, '');
    const after = lines.slice(firstEntryIdx).join('\n');
    return `${before}\n\n${entry}\n${after}`;
}
