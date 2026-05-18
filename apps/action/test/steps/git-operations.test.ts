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
});
