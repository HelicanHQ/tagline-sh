import { describe, it, expect } from 'vitest';
import { commitBump, parseCommit, parsePR } from '../../src/services/commit-parser.js';
import type { CommitRef, PullRequestSummary } from '../../src/services/github-reader.js';

describe('parseCommit', () => {
    it('parses a minimal feat commit', () => {
        const p = parseCommit('sha1', 'feat: add login');
        expect(p).toMatchObject({
            type: 'feat',
            scope: null,
            subject: 'add login',
            body: null,
            isBreaking: false,
        });
    });

    it('parses scope and body', () => {
        const p = parseCommit('sha2', 'fix(auth): handle null token\n\nReplaces the unsafe cast.');
        expect(p).toMatchObject({
            type: 'fix',
            scope: 'auth',
            subject: 'handle null token',
            body: 'Replaces the unsafe cast.',
        });
    });

    it('flags ! after type as breaking', () => {
        const p = parseCommit('sha3', 'feat!: remove legacy API');
        expect(p?.isBreaking).toBe(true);
    });

    it('flags ! after scope as breaking', () => {
        const p = parseCommit('sha4', 'feat(api)!: remove /v1');
        expect(p?.isBreaking).toBe(true);
    });

    it('flags BREAKING CHANGE footer as breaking', () => {
        const p = parseCommit(
            'sha5',
            'feat(api): new endpoint\n\nBREAKING CHANGE: removes /v1 entirely.',
        );
        expect(p?.isBreaking).toBe(true);
    });

    it('returns null for non-conformant header', () => {
        expect(parseCommit('sha6', 'wip')).toBeNull();
        expect(parseCommit('sha7', 'random message')).toBeNull();
    });

    it('coerces unknown types to chore', () => {
        const p = parseCommit('sha8', 'unknownType: did stuff');
        expect(p?.type).toBe('chore');
    });
});

describe('commitBump', () => {
    it('major for breaking changes regardless of type', () => {
        expect(commitBump(parseCommit('s', 'fix!: kill /v1')!)).toBe('major');
    });
    it('minor for feat', () => {
        expect(commitBump(parseCommit('s', 'feat: new thing')!)).toBe('minor');
    });
    it('patch for fix / perf / revert', () => {
        expect(commitBump(parseCommit('s', 'fix: bug')!)).toBe('patch');
        expect(commitBump(parseCommit('s', 'perf: speed')!)).toBe('patch');
        expect(commitBump(parseCommit('s', 'revert: thing')!)).toBe('patch');
    });
    it('none for docs / chore / style / etc', () => {
        expect(commitBump(parseCommit('s', 'docs: readme')!)).toBe('none');
        expect(commitBump(parseCommit('s', 'chore: bump')!)).toBe('none');
    });
});

const baseSummary: PullRequestSummary = {
    number: 42,
    title: 'feat: add export',
    body: 'Closes PROJ-101 and #99.',
    url: 'https://github.com/acme/widget/pull/42',
    author: 'octocat',
    mergedAt: '2026-05-17T10:00:00Z',
    baseRef: 'main',
    headRef: 'feature/export',
};

describe('parsePR', () => {
    it('rolls up commits and picks max bump', () => {
        const commits: CommitRef[] = [
            { sha: 'a', message: 'docs: readme', author: 'oct' },
            { sha: 'b', message: 'feat: csv export', author: 'oct' },
            { sha: 'c', message: 'fix: edge case', author: 'oct' },
        ];
        const { pr } = parsePR(baseSummary, commits);
        expect(pr.commits).toHaveLength(3);
        expect(pr.suggestedBump).toBe('minor');
    });

    it('falls back to the PR title when no commits parse', () => {
        const commits: CommitRef[] = [
            { sha: 'a', message: 'wip', author: 'oct' },
            { sha: 'b', message: 'more work', author: 'oct' },
        ];
        const { pr, nonConformant } = parsePR(baseSummary, commits);
        expect(nonConformant).toBe(true);
        expect(pr.commits).toHaveLength(1);
        // Title is `feat: add export`, so the synthesized commit is a feat.
        expect(pr.commits[0]?.type).toBe('feat');
        expect(pr.suggestedBump).toBe('minor');
    });

    it('synthesizes a chore when both commits and title fail to parse', () => {
        const summary = { ...baseSummary, title: 'work in progress' };
        const { pr, nonConformant } = parsePR(summary, [
            { sha: 'a', message: 'wip', author: null },
        ]);
        expect(nonConformant).toBe(true);
        expect(pr.commits[0]?.type).toBe('chore');
        expect(pr.suggestedBump).toBe('none');
    });

    it('extracts tickets from both title and body', () => {
        const summary = {
            ...baseSummary,
            title: 'feat: thing for PROJ-1',
            body: 'Closes #42 and eng-7',
        };
        const { pr } = parsePR(summary, [{ sha: 'a', message: 'feat: thing', author: null }]);
        expect(pr.tickets).toEqual(expect.arrayContaining(['PROJ-1', '#42', 'eng-7']));
    });

    it('reports unparseable commits as failures', () => {
        const { parseFailures } = parsePR(baseSummary, [
            { sha: 'a', message: 'feat: ok', author: null },
            { sha: 'b', message: 'gobbledygook', author: null },
        ]);
        expect(parseFailures).toEqual([
            expect.objectContaining({ sha: 'b', reason: 'no-header-match' }),
        ]);
    });
});
