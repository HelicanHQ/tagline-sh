import { describe, it, expect } from 'vitest';
import {
    getCurrentVersion,
    getLastReleaseTag,
    getPRsSinceLastTag,
    hydratePRs,
} from '../../src/services/pr-reader.js';
import { ANY_REPO, FakeGitHubReader } from '../fixtures/fake-reader.js';

describe('getLastReleaseTag', () => {
    it('returns null when there are no tags', async () => {
        const reader = new FakeGitHubReader({ tags: [] });
        expect(await getLastReleaseTag(reader, ANY_REPO)).toBeNull();
    });

    it('returns the highest semver tag regardless of creation order', async () => {
        const reader = new FakeGitHubReader({
            tags: [
                { name: 'v1.0.0', sha: 'a', commitDate: '2026-01-01T00:00:00Z' },
                { name: 'v2.0.0', sha: 'b', commitDate: '2026-03-01T00:00:00Z' },
                { name: 'v1.5.0', sha: 'c', commitDate: '2026-05-01T00:00:00Z' }, // back-port
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        expect(tag?.name).toBe('v2.0.0');
    });

    it('filters out non-semver tags', async () => {
        const reader = new FakeGitHubReader({
            tags: [
                { name: 'release-candidate', sha: 'a', commitDate: 't' },
                { name: 'v1.0.0', sha: 'b', commitDate: 't' },
                { name: 'nightly-2026', sha: 'c', commitDate: 't' },
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        expect(tag?.name).toBe('v1.0.0');
    });

    it('accepts both v-prefixed and bare semver tags', async () => {
        const reader = new FakeGitHubReader({
            tags: [
                { name: '0.9.0', sha: 'a', commitDate: 't' },
                { name: 'v1.0.0', sha: 'b', commitDate: 't' },
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        expect(tag?.name).toBe('v1.0.0');
    });
});

describe('getCurrentVersion', () => {
    it('reads version from package.json when present', async () => {
        const reader = new FakeGitHubReader({
            files: { 'package.json': JSON.stringify({ version: '1.4.2' }) },
        });
        expect(await getCurrentVersion(reader, ANY_REPO)).toBe('1.4.2');
    });

    it('falls back to the latest tag when package.json has no version', async () => {
        const reader = new FakeGitHubReader({
            files: { 'package.json': '{}' },
            tags: [{ name: 'v0.5.0', sha: 'a', commitDate: 't' }],
        });
        expect(await getCurrentVersion(reader, ANY_REPO)).toBe('0.5.0');
    });

    it('falls back to the latest tag when package.json is missing', async () => {
        const reader = new FakeGitHubReader({
            tags: [{ name: 'v0.5.0', sha: 'a', commitDate: 't' }],
        });
        expect(await getCurrentVersion(reader, ANY_REPO)).toBe('0.5.0');
    });

    it('returns 0.0.0 when nothing is available (first release)', async () => {
        const reader = new FakeGitHubReader({});
        expect(await getCurrentVersion(reader, ANY_REPO)).toBe('0.0.0');
    });

    it('ignores invalid versions in package.json', async () => {
        const reader = new FakeGitHubReader({
            files: { 'package.json': JSON.stringify({ version: 'not-semver' }) },
            tags: [{ name: 'v0.5.0', sha: 'a', commitDate: 't' }],
        });
        expect(await getCurrentVersion(reader, ANY_REPO)).toBe('0.5.0');
    });
});

describe('getPRsSinceLastTag', () => {
    it('returns PRs merged after the last-tag date, on the target branch', async () => {
        const reader = new FakeGitHubReader({
            tags: [{ name: 'v1.0.0', sha: 'a', commitDate: '2026-01-01T00:00:00Z' }],
            mergedPRs: [
                {
                    number: 1,
                    title: 'old',
                    body: null,
                    url: 'u1',
                    author: 'a',
                    mergedAt: '2025-12-01T00:00:00Z', // BEFORE the tag
                    baseRef: 'main',
                    headRef: 'h',
                },
                {
                    number: 2,
                    title: 'new',
                    body: null,
                    url: 'u2',
                    author: 'a',
                    mergedAt: '2026-02-01T00:00:00Z',
                    baseRef: 'main',
                    headRef: 'h',
                },
                {
                    number: 3,
                    title: 'on staging',
                    body: null,
                    url: 'u3',
                    author: 'a',
                    mergedAt: '2026-02-01T00:00:00Z',
                    baseRef: 'staging', // wrong branch
                    headRef: 'h',
                },
            ],
        });
        const { prs, lastTag } = await getPRsSinceLastTag(reader, ANY_REPO, 'main');
        expect(lastTag?.name).toBe('v1.0.0');
        expect(prs.map((p) => p.number)).toEqual([2]);
    });

    it('returns all PRs when there is no prior tag (first release)', async () => {
        const reader = new FakeGitHubReader({
            mergedPRs: [
                {
                    number: 1,
                    title: 'first',
                    body: null,
                    url: 'u',
                    author: 'a',
                    mergedAt: '2026-01-01T00:00:00Z',
                    baseRef: 'main',
                    headRef: 'h',
                },
            ],
        });
        const { prs, lastTag } = await getPRsSinceLastTag(reader, ANY_REPO, 'main');
        expect(lastTag).toBeNull();
        expect(prs).toHaveLength(1);
    });
});

describe('hydratePRs', () => {
    it('parses PRs and attaches changed files', async () => {
        const reader = new FakeGitHubReader({
            mergedPRs: [
                {
                    number: 7,
                    title: 'feat(api): x',
                    body: 'closes PROJ-1',
                    url: 'u',
                    author: 'oct',
                    mergedAt: '2026-02-01T00:00:00Z',
                    baseRef: 'main',
                    headRef: 'h',
                },
            ],
            prCommits: {
                7: [{ sha: 'c1', message: 'feat(api): x', author: 'oct' }],
            },
            prFiles: {
                7: [{ filename: 'packages/api/src/x.ts' }, { filename: 'README.md' }],
            },
        });
        const hydrated = await hydratePRs(reader, ANY_REPO, [
            {
                number: 7,
                title: 'feat(api): x',
                body: 'closes PROJ-1',
                url: 'u',
                author: 'oct',
                mergedAt: '2026-02-01T00:00:00Z',
                baseRef: 'main',
                headRef: 'h',
            },
        ]);
        expect(hydrated).toHaveLength(1);
        const [first] = hydrated;
        expect(first!.pr.tickets).toContain('PROJ-1');
        expect(first!.pr.suggestedBump).toBe('minor');
        expect(first!.files).toEqual(['packages/api/src/x.ts', 'README.md']);
        expect(first!.nonConformant).toBe(false);
    });
});
