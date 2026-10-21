import { describe, it, expect, vi } from 'vitest';
import {
    commitAndPushBranch,
    tagMergeCommit,
    type TagMergeOctokit,
} from '../../src/steps/git-operations.js';
import { makePlan } from '../fixtures/plan.js';

interface GitCalls {
    addConfig: ReturnType<typeof vi.fn>;
    checkoutLocalBranch: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    push: ReturnType<typeof vi.fn>;
}

function fakeGit(): { git: ReturnType<typeof asGit>; calls: GitCalls } {
    const calls: GitCalls = {
        addConfig: vi.fn(async () => {}),
        checkoutLocalBranch: vi.fn(async () => {}),
        add: vi.fn(async () => {}),
        commit: vi.fn(async () => ({
            commit: 'abc123',
            branch: '',
            summary: { changes: 0, insertions: 0, deletions: 0 },
        })),
        push: vi.fn(async () => {}),
    };
    return { git: asGit(calls), calls };
}

function asGit(calls: GitCalls): NonNullable<Parameters<typeof commitAndPushBranch>[2]>['git'] {
    return calls as unknown as NonNullable<Parameters<typeof commitAndPushBranch>[2]>['git'];
}

describe('commitAndPushBranch (Phase A — propose)', () => {
    it('configures bot identity, creates the release branch, commits with [skip ci], pushes branch only — no tag', async () => {
        const { git, calls } = fakeGit();
        const result = await commitAndPushBranch(makePlan(), '/tmp/repo', { git });

        expect(result.branch).toBe('release/v1.5.0');
        expect(result.commitSha).toBe('abc123');

        expect(calls.addConfig).toHaveBeenCalledWith('user.name', 'tagline-sh[bot]');
        expect(calls.checkoutLocalBranch).toHaveBeenCalledWith('release/v1.5.0');
        expect(calls.commit.mock.calls[0]?.[0]).toContain('[skip ci]');
        // Exactly one push: the branch. NO tag push during propose phase.
        expect(calls.push).toHaveBeenCalledTimes(1);
        const pushArgs = calls.push.mock.calls[0]?.[0] as string[];
        expect(pushArgs).toEqual(['-u', 'origin', 'release/v1.5.0']);
    });

    it('skips push when skipPush is set (dry-run paranoia)', async () => {
        const { git, calls } = fakeGit();
        await commitAndPushBranch(makePlan(), '/tmp/repo', { git, skipPush: true });
        expect(calls.push).not.toHaveBeenCalled();
    });

    it('uses the issue-keyed event branch name for monorepo plans', async () => {
        const { git } = fakeGit();
        const plan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-i7',
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
            ],
        });
        const result = await commitAndPushBranch(plan, '/tmp/repo', { git });
        expect(result.branch).toBe('release/event-i7');
    });
});

function fakeOctokit(opts: { existing?: Record<string, string> } = {}): {
    octokit: TagMergeOctokit;
    calls: { createRef: ReturnType<typeof vi.fn>; getRef: ReturnType<typeof vi.fn> };
} {
    const existing = new Map(Object.entries(opts.existing ?? {}));
    const getRef = vi.fn(async (params: { ref: string }) => {
        const tag = params.ref.replace(/^tags\//, '');
        const sha = existing.get(tag);
        if (!sha) {
            const err = new Error('Not Found') as Error & { status: number };
            err.status = 404;
            throw err;
        }
        return { data: { object: { sha, type: 'commit' } } };
    });
    const createRef = vi.fn(async (params: { ref: string; sha: string }) => {
        const tag = params.ref.replace(/^refs\/tags\//, '');
        if (existing.has(tag)) {
            throw new Error('Reference already exists');
        }
        existing.set(tag, params.sha);
        return { data: { ref: params.ref } };
    });
    const getTag = vi.fn(async () => ({ data: { object: { sha: '', type: 'commit' } } }));
    const octokit = { rest: { git: { createRef, getRef, getTag } } } as TagMergeOctokit;
    return { octokit, calls: { createRef, getRef } };
}

describe('tagMergeCommit (Phase B — finalize)', () => {
    it('creates each tag via Octokit at the merge SHA', async () => {
        const { octokit, calls } = fakeOctokit();
        const result = await tagMergeCommit(
            {
                repoOwner: 'acme',
                repoName: 'widget',
                sha: 'merge-sha',
                tags: ['v1.5.0'],
            },
            octokit,
        );

        expect(result.created).toEqual(['v1.5.0']);
        expect(result.skipped).toEqual([]);
        expect(calls.createRef).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'widget',
            ref: 'refs/tags/v1.5.0',
            sha: 'merge-sha',
        });
    });

    it('idempotently skips tags that already exist instead of throwing', async () => {
        const { octokit } = fakeOctokit({ existing: { 'v1.5.0': 'merge-sha' } });
        const result = await tagMergeCommit(
            {
                repoOwner: 'acme',
                repoName: 'widget',
                sha: 'merge-sha',
                tags: ['v1.5.0'],
            },
            octokit,
        );
        expect(result.created).toEqual([]);
        expect(result.skipped).toEqual(['v1.5.0']);
    });

    it('resolves an annotated tag before deciding a retry is safe', async () => {
        const createRef = vi.fn(async () => ({ data: { ref: '' } }));
        const getRef = vi.fn(async () => ({
            data: { object: { sha: 'tag-object-sha', type: 'tag' } },
        }));
        const getTag = vi.fn(async () => ({
            data: { object: { sha: 'merge-sha', type: 'commit' } },
        }));
        const octokit = { rest: { git: { createRef, getRef, getTag } } } as TagMergeOctokit;

        const result = await tagMergeCommit(
            {
                repoOwner: 'acme',
                repoName: 'widget',
                sha: 'merge-sha',
                tags: ['v1.5.0'],
            },
            octokit,
        );

        expect(result.skipped).toEqual(['v1.5.0']);
        expect(getTag).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'widget',
            tag_sha: 'tag-object-sha',
        });
        expect(createRef).not.toHaveBeenCalled();
    });

    it('fails before writing when an existing tag points at another commit', async () => {
        const { octokit, calls } = fakeOctokit({ existing: { 'v1.5.0': 'wrong-sha' } });

        await expect(
            tagMergeCommit(
                {
                    repoOwner: 'acme',
                    repoName: 'widget',
                    sha: 'merge-sha',
                    tags: ['v1.5.0', 'v1.5.1'],
                },
                octokit,
            ),
        ).rejects.toThrow(/wrong-sha.*expected merge-sha/);
        expect(calls.createRef).not.toHaveBeenCalled();
    });

    it('rechecks the SHA when another run creates the tag after preflight', async () => {
        const getRef = vi
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
            .mockResolvedValueOnce({
                data: { object: { sha: 'merge-sha', type: 'commit' } },
            });
        const createRef = vi.fn(async () => {
            throw new Error('Reference already exists');
        });
        const getTag = vi.fn(async () => ({
            data: { object: { sha: 'merge-sha', type: 'commit' } },
        }));
        const octokit = { rest: { git: { createRef, getRef, getTag } } } as TagMergeOctokit;

        const result = await tagMergeCommit(
            {
                repoOwner: 'acme',
                repoName: 'widget',
                sha: 'merge-sha',
                tags: ['v1.5.0'],
            },
            octokit,
        );

        expect(result).toEqual({ created: [], skipped: ['v1.5.0'] });
    });

    it('creates one ref per package for monorepo finalize', async () => {
        const { octokit, calls } = fakeOctokit();
        const result = await tagMergeCommit(
            {
                repoOwner: 'acme',
                repoName: 'monorepo',
                sha: 'merge-sha',
                tags: ['@acme/api@1.1.0', '@acme/ui@0.5.1'],
            },
            octokit,
        );

        expect(result.created).toEqual(['@acme/api@1.1.0', '@acme/ui@0.5.1']);
        expect(calls.createRef).toHaveBeenCalledTimes(2);
    });

    it('rethrows non-conflict errors (e.g. permission denied) instead of silently skipping', async () => {
        const notFound = new Error('Not Found') as Error & { status: number };
        notFound.status = 404;
        const getRef = vi.fn(async () => {
            throw notFound;
        });
        const createRef = vi.fn(async () => {
            throw new Error('Resource not accessible by integration');
        });
        const getTag = vi.fn(async () => ({
            data: { object: { sha: 'merge-sha', type: 'commit' } },
        }));
        const octokit = { rest: { git: { createRef, getRef, getTag } } } as TagMergeOctokit;
        await expect(
            tagMergeCommit(
                {
                    repoOwner: 'acme',
                    repoName: 'widget',
                    sha: 'merge-sha',
                    tags: ['v1.5.0'],
                },
                octokit,
            ),
        ).rejects.toThrow(/Resource not accessible/);
    });
});
