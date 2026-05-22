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

    // Monorepo / migration regressions ---------------------------------------
    //
    // The bug that surfaced these tests: a repo that migrated from single-repo
    // (where `v1.0.0` was the live tag) to per-package monorepo tags (like
    // `@tagline-sh/bot@0.1.0`) was still resolving "last release" to `v1.0.0`
    // because the SEMVER_TAG_RE didn't recognize the `@scope/name@version`
    // shape. That made the release-issue title read "5 changes since v1.0.0"
    // even though three per-package releases had happened since.

    it('recognizes scoped per-package tags (Changesets-style)', async () => {
        const reader = new FakeGitHubReader({
            tags: [
                { name: '@acme/api@1.0.0', sha: 'a', commitDate: '2026-05-01T00:00:00Z' },
                { name: '@acme/ui@0.5.0', sha: 'b', commitDate: '2026-05-15T00:00:00Z' },
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        // Per-package tags sort by commit date; ui shipped later.
        expect(tag?.name).toBe('@acme/ui@0.5.0');
    });

    it('recognizes unscoped per-package tags', async () => {
        const reader = new FakeGitHubReader({
            tags: [
                { name: 'api@1.0.0', sha: 'a', commitDate: '2026-05-01T00:00:00Z' },
                { name: 'webapp@2.3.0', sha: 'b', commitDate: '2026-05-15T00:00:00Z' },
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        expect(tag?.name).toBe('webapp@2.3.0');
    });

    it('prefers the most recent per-package tag when v* legacy tags exist (the migration case)', async () => {
        // The exact failure shape: legacy v1.0.0 from before monorepo
        // mode, then per-package tags from the new release line. Without
        // commit-date sort in the mixed case, the old code picked v1.0.0
        // because it semver-sorted higher than the per-package versions
        // (which use independent version namespaces).
        const reader = new FakeGitHubReader({
            tags: [
                { name: 'v1.0.0', sha: 'legacy', commitDate: '2026-03-01T00:00:00Z' },
                { name: '@tagline-sh/action@0.1.0', sha: 'a', commitDate: '2026-05-21T00:00:00Z' },
                { name: '@tagline-sh/bot@0.1.0', sha: 'b', commitDate: '2026-05-21T00:00:00Z' },
                { name: '@tagline-sh/shared@0.1.0', sha: 'c', commitDate: '2026-05-21T00:00:00Z' },
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        // Any of the three per-package tags is acceptable — they share a
        // commit date. The critical assertion is that v1.0.0 is NOT picked.
        expect(tag?.name).not.toBe('v1.0.0');
        expect(tag?.name).toMatch(/^@tagline-sh\/(action|bot|shared)@0\.1\.0$/);
    });

    it('rejects arbitrary name@something tags that aren\'t valid semver versions', async () => {
        const reader = new FakeGitHubReader({
            tags: [
                { name: 'feature@experiment', sha: 'a', commitDate: 't' },
                { name: 'release@beta', sha: 'b', commitDate: 't' },
                { name: 'v1.0.0', sha: 'c', commitDate: 't' },
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        expect(tag?.name).toBe('v1.0.0');
    });

    it('falls back to commit-date sort when only per-package tags exist (no legacy v*)', async () => {
        // Pure monorepo case: every tag is per-package, no legacy single-repo
        // tag in the mix. The commit-date path still has to fire (semver sort
        // across different package namespaces would be meaningless).
        const reader = new FakeGitHubReader({
            tags: [
                { name: '@acme/api@1.5.0', sha: 'a', commitDate: '2026-04-01T00:00:00Z' },
                { name: '@acme/ui@0.9.0', sha: 'b', commitDate: '2026-05-10T00:00:00Z' },
                { name: '@acme/api@1.6.0', sha: 'c', commitDate: '2026-05-15T00:00:00Z' },
            ],
        });
        const tag = await getLastReleaseTag(reader, ANY_REPO);
        expect(tag?.name).toBe('@acme/api@1.6.0');
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

    it('filters out the previous release PR (head ref `release/v…`)', async () => {
        // Reproduces the velaops scenario: previous tag is `v2026.5.9` (on the
        // release-branch tip), and the actual merge of PR #68 — which created
        // that tag's branch — lands on `main` slightly after the tag's
        // commitDate. Without the filter, PR #68 leaks into the next release.
        const reader = new FakeGitHubReader({
            tags: [{ name: 'v2026.5.9', sha: 'a', commitDate: '2026-05-18T10:00:00Z' }],
            mergedPRs: [
                {
                    number: 68,
                    title: 'chore(release): v2026.5.9 [skip ci]',
                    body: 'changelog with #55 #58 #61 references…',
                    url: 'u68',
                    author: 'github-actions[bot]',
                    mergedAt: '2026-05-18T10:05:00Z', // AFTER tag's commitDate
                    baseRef: 'main',
                    headRef: 'release/v2026.5.9',
                },
                {
                    number: 71,
                    title: 'feat: real change',
                    body: null,
                    url: 'u71',
                    author: 'dev',
                    mergedAt: '2026-05-19T09:00:00Z',
                    baseRef: 'main',
                    headRef: 'feat/real-change',
                },
            ],
        });
        const { prs } = await getPRsSinceLastTag(reader, ANY_REPO, 'main');
        // Only the real feature PR survives — the bot's own release PR is gone.
        expect(prs.map((p) => p.number)).toEqual([71]);
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
