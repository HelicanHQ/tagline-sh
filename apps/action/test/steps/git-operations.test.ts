import { describe, it, expect, vi } from 'vitest';
import { commitAndTag } from '../../src/steps/git-operations.js';
import { makePlan } from '../fixtures/plan.js';

interface GitCalls {
    addConfig: ReturnType<typeof vi.fn>;
    checkoutLocalBranch: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    addAnnotatedTag: ReturnType<typeof vi.fn>;
    push: ReturnType<typeof vi.fn>;
    tags: ReturnType<typeof vi.fn>;
}

function fakeGit(existingTags: string[] = []): { git: ReturnType<typeof asGit>; calls: GitCalls } {
    const calls: GitCalls = {
        addConfig: vi.fn(async () => {}),
        checkoutLocalBranch: vi.fn(async () => {}),
        add: vi.fn(async () => {}),
        commit: vi.fn(async () => ({ commit: 'abc123', branch: '', summary: { changes: 0, insertions: 0, deletions: 0 } })),
        addAnnotatedTag: vi.fn(async () => {}),
        push: vi.fn(async () => {}),
        tags: vi.fn(async () => ({ all: existingTags, latest: existingTags[0] ?? '' })),
    };
    return { git: asGit(calls), calls };
}

function asGit(calls: GitCalls): NonNullable<Parameters<typeof commitAndTag>[2]>['git'] {
    return calls as unknown as NonNullable<Parameters<typeof commitAndTag>[2]>['git'];
}

describe('commitAndTag', () => {
    it('configures bot identity, branches, commits with [skip ci], tags, and pushes', async () => {
        const { git, calls } = fakeGit();
        const result = await commitAndTag(makePlan(), '/tmp/repo', { git });

        expect(result.branch).toBe('release/v1.5.0');
        expect(result.tag).toBe('v1.5.0');
        expect(result.commitSha).toBe('abc123');

        expect(calls.addConfig).toHaveBeenCalledWith('user.name', 'tagline-sh[bot]');
        expect(calls.checkoutLocalBranch).toHaveBeenCalledWith('release/v1.5.0');
        expect(calls.commit.mock.calls[0]?.[0]).toContain('[skip ci]');
        expect(calls.addAnnotatedTag).toHaveBeenCalledWith('v1.5.0', 'Release v1.5.0');
        expect(calls.push).toHaveBeenCalledTimes(2); // branch + tag
    });

    it('throws (idempotency) when the tag already exists', async () => {
        const { git } = fakeGit(['v1.5.0']);
        await expect(commitAndTag(makePlan(), '/tmp/repo', { git })).rejects.toThrow(
            /already exists/,
        );
    });

    it('skips push when skipPush is set (dry-run paranoia)', async () => {
        const { git, calls } = fakeGit();
        await commitAndTag(makePlan(), '/tmp/repo', { git, skipPush: true });
        expect(calls.push).not.toHaveBeenCalled();
    });

    it('pushes one annotated tag PER package for monorepo plans (M3)', async () => {
        const { git, calls } = fakeGit();
        const plan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-2026-05-19',
            packages: [
                {
                    name: '@acme/api',
                    path: 'packages/api',
                    packageJsonPath: 'packages/api/package.json',
                    changelogPath: 'packages/api/CHANGELOG.md',
                    currentVersion: '1.0.0',
                    nextVersion: '1.1.0',
                    bumpType: 'minor',
                    prs: [],
                    changelogContent: '## [1.1.0]\n',
                    tagName: '@acme/api@1.1.0',
                },
                {
                    name: '@acme/ui',
                    path: 'packages/ui',
                    packageJsonPath: 'packages/ui/package.json',
                    changelogPath: 'packages/ui/CHANGELOG.md',
                    currentVersion: '0.5.0',
                    nextVersion: '0.5.1',
                    bumpType: 'patch',
                    prs: [],
                    changelogContent: '## [0.5.1]\n',
                    tagName: '@acme/ui@0.5.1',
                },
            ],
        });

        const result = await commitAndTag(plan, '/tmp/repo', { git });

        // Branch uses the event id (release/vevent-…).
        expect(result.branch).toBe('release/vevent-2026-05-19');
        // Both tags surface on the result.
        expect(result.tags).toEqual(['@acme/api@1.1.0', '@acme/ui@0.5.1']);
        expect(result.tag).toContain('@acme/api@1.1.0');
        expect(result.tag).toContain('@acme/ui@0.5.1');

        // One annotated tag call per package.
        expect(calls.addAnnotatedTag).toHaveBeenCalledTimes(2);
        expect(calls.addAnnotatedTag).toHaveBeenCalledWith(
            '@acme/api@1.1.0',
            'Release @acme/api@1.1.0',
        );
        expect(calls.addAnnotatedTag).toHaveBeenCalledWith(
            '@acme/ui@0.5.1',
            'Release @acme/ui@0.5.1',
        );

        // 1 branch push + 2 tag pushes = 3 push calls.
        expect(calls.push).toHaveBeenCalledTimes(3);
    });

    it('refuses the entire monorepo release when ANY package tag already exists', async () => {
        // Pre-existing `@acme/api@1.1.0` should abort the release before any
        // checkout/commit happens — partial monorepo state is worse than
        // failing fast.
        const { git } = fakeGit(['@acme/api@1.1.0']);
        const plan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-2026-05-19',
            packages: [
                {
                    name: '@acme/api',
                    path: 'packages/api',
                    packageJsonPath: 'packages/api/package.json',
                    changelogPath: 'packages/api/CHANGELOG.md',
                    currentVersion: '1.0.0',
                    nextVersion: '1.1.0',
                    bumpType: 'minor',
                    prs: [],
                    changelogContent: '## [1.1.0]\n',
                    tagName: '@acme/api@1.1.0',
                },
                {
                    name: '@acme/ui',
                    path: 'packages/ui',
                    packageJsonPath: 'packages/ui/package.json',
                    changelogPath: 'packages/ui/CHANGELOG.md',
                    currentVersion: '0.5.0',
                    nextVersion: '0.5.1',
                    bumpType: 'patch',
                    prs: [],
                    changelogContent: '## [0.5.1]\n',
                    tagName: '@acme/ui@0.5.1',
                },
            ],
        });

        await expect(commitAndTag(plan, '/tmp/repo', { git })).rejects.toThrow(
            /@acme\/api@1\.1\.0/,
        );
    });
});
