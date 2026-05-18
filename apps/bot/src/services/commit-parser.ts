import {
    aggregateBumps,
    excerpt,
    extractTickets,
    type BumpType,
    type CommitType,
    type ParsedCommit,
    type ParsedPR,
    COMMIT_TYPE_BUMP,
} from '@tagline-sh/shared';
import type { CommitRef, PullRequestSummary } from './github-reader.js';

// Conventional Commits grammar:
//   <type>(<scope>)?(!)?: <subject>
//   [blank line]
//   <body>
//   [blank line]
//   [footer with optional `BREAKING CHANGE:` token]
//
// We parse this with a small regex pair instead of pulling in
// `conventional-commits-parser` because (a) the spec is short, (b) the upstream
// lib has switched to an async-iterator API that is awkward to drive from
// our otherwise-synchronous code, and (c) we want explicit control over how
// non-conformant commits are flagged.

const HEADER_RE = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<subject>.+)$/;

const BREAKING_FOOTER_RE = /^BREAKING[- ]CHANGE:\s*(.+)$/m;

export interface CommitParseFailure {
    sha: string;
    message: string;
    reason: 'no-header-match' | 'unknown-type';
}

const KNOWN_TYPES = new Set<CommitType>([
    'feat',
    'fix',
    'docs',
    'style',
    'refactor',
    'perf',
    'test',
    'build',
    'ci',
    'chore',
    'revert',
    'breaking',
]);

/**
 * Parse a single commit message. Returns `null` if the header line does not
 * match the conventional-commits format. Unknown types still parse but are
 * coerced to `chore`.
 */
export function parseCommit(sha: string, message: string): ParsedCommit | null {
    if (!message) return null;

    const lines = message.split('\n');
    const header = (lines[0] ?? '').trim();
    const match = HEADER_RE.exec(header);
    if (!match || !match.groups) return null;

    const rawType = match.groups['type']!.toLowerCase();
    const scope = match.groups['scope']?.trim() || null;
    const subject = match.groups['subject']!.trim();
    const bang = Boolean(match.groups['bang']);

    const body = lines.slice(1).join('\n').trim() || null;
    const breakingFromFooter = BREAKING_FOOTER_RE.test(message);
    const isBreaking = bang || breakingFromFooter;

    const type: CommitType = KNOWN_TYPES.has(rawType as CommitType)
        ? (rawType as CommitType)
        : 'chore';

    return { type, scope, subject, body, isBreaking, sha };
}

/** Bump implied by a single parsed commit. Breaking always wins. */
export function commitBump(commit: ParsedCommit): BumpType {
    if (commit.isBreaking) return 'major';
    return COMMIT_TYPE_BUMP[commit.type] ?? 'none';
}

export interface ParsePRResult {
    pr: ParsedPR;
    /** True if no commit was parseable and we fell back to the PR title. */
    nonConformant: boolean;
    parseFailures: CommitParseFailure[];
}

/**
 * Parse all commits of a PR and roll them up into a `ParsedPR`.
 *
 * Behavior when no commit follows the conventional-commits format:
 *   1. Try parsing the PR title as a conventional commit header.
 *   2. If that also fails, synthesize a single `chore` commit and flag the PR
 *      so the report can warn the lead.
 */
export function parsePR(summary: PullRequestSummary, commits: CommitRef[]): ParsePRResult {
    const parsedCommits: ParsedCommit[] = [];
    const failures: CommitParseFailure[] = [];

    for (const c of commits) {
        const parsed = parseCommit(c.sha, c.message);
        if (parsed) {
            parsedCommits.push(parsed);
        } else {
            failures.push({ sha: c.sha, message: c.message, reason: 'no-header-match' });
        }
    }

    let nonConformant = false;

    if (parsedCommits.length === 0) {
        nonConformant = true;
        const fromTitle = parseCommit(`pr-${summary.number}`, summary.title);
        if (fromTitle) {
            parsedCommits.push(fromTitle);
        } else {
            parsedCommits.push({
                type: 'chore',
                scope: null,
                subject: summary.title,
                body: null,
                isBreaking: false,
                sha: `pr-${summary.number}`,
            });
        }
    }

    const ticketSource = [summary.title, summary.body ?? ''].join('\n');
    const tickets = extractTickets(ticketSource);

    const suggestedBump = aggregateBumps(parsedCommits.map(commitBump));

    const pr: ParsedPR = {
        number: summary.number,
        title: summary.title,
        url: summary.url,
        author: summary.author,
        mergedAt: summary.mergedAt,
        commits: parsedCommits,
        tickets,
        suggestedBump,
        bodyExcerpt: excerpt(summary.body),
    };

    return { pr, nonConformant, parseFailures: failures };
}

/** Aggregate suggested bumps across many PRs (repo-level recommendation). */
export function aggregatePRBumps(prs: ParsedPR[]): BumpType {
    return aggregateBumps(prs.map((p) => p.suggestedBump));
}
