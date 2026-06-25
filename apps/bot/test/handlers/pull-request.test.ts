import { describe, it, expect, vi } from 'vitest';
import { manageReleaseIssue } from '../../src/handlers/pull-request.js';
import { ANY_REPO, FakeGitHubReader } from '../fixtures/fake-reader.js';
import {
    RELEASE_ISSUE_LABEL,
    encodeMarker,
    type ReleaseIssueOctokit,
} from '../../src/services/release-issue.js';

function fakeIssuesOctokit(opts: {
    listForRepoData?: Array<{
        number: number;
        title: string;
        body: string | null;
        state: string;
        pull_request?: unknown;
    }>;
} = {}) {
    const calls = {
        listForRepo: vi.fn(async () => ({ data: opts.listForRepoData ?? [] })),
        create: vi.fn(async () => ({ data: { number: 999, html_url: 'created-url' } })),
        update: vi.fn(async () => ({ data: { number: 999 } })),
        createComment: vi.fn(async () => ({ data: { id: 1, html_url: 'c' } })),
        removeLabel: vi.fn(async () => ({})),
        getLabel: vi.fn(async () => ({ data: { name: RELEASE_ISSUE_LABEL } })),
        createLabel: vi.fn(async () => ({ data: { name: RELEASE_ISSUE_LABEL } })),
    };
    const octokit = {
        rest: {
            issues: {
                listForRepo: calls.listForRepo,
                create: calls.create,
                update: calls.update,
                createComment: calls.createComment,
                removeLabel: calls.removeLabel,
                getLabel: calls.getLabel,
                createLabel: calls.createLabel,
            },
        },
    } as unknown as ReleaseIssueOctokit;
    return { octokit, calls };
}

function firstCallArg<T>(spy: ReturnType<typeof vi.fn>): T {
    const calls = spy.mock.calls as unknown as Array<[T]>;
    const first = calls[0];
    if (!first) throw new Error('expected spy to have been called');
    return first[0];
}

const BASE_INPUT = {
    repo: ANY_REPO,
    pr: {
        number: 42,
        merged: true,
        baseRef: 'main',
        headRef: 'feature/x',
        title: 'feat: cool thing',
        url: 'https://github.com/acme/widget/pull/42',
        author: 'octocat',
        mergedAt: '2026-05-20T10:00:00Z',
        body: null,
    },
};

describe('manageReleaseIssue — skip conditions', () => {
    it('skips when PR is not merged (closed without merging)', async () => {
        const reader = new FakeGitHubReader({});
        const { octokit, calls } = fakeIssuesOctokit();
        const outcome = await manageReleaseIssue(
            { ...BASE_INPUT, pr: { ...BASE_INPUT.pr, merged: false } },
            { reader, octokit },
        );
        expect(outcome).toEqual({ kind: 'skipped', reason: 'not-merged' });
        // No issue API calls at all.
        expect(calls.listForRepo).not.toHaveBeenCalled();
    });

    it('skips when PR head ref is release/* (Phase B handles those)', async () => {
        // The Tagline release PR itself merges to main. Without this guard,
        // the handler would try to update the release-tracking issue at the
        // same moment Phase B is trying to close it — a race.
        const reader = new FakeGitHubReader({});
        const { octokit, calls } = fakeIssuesOctokit();
        const outcome = await manageReleaseIssue(
            { ...BASE_INPUT, pr: { ...BASE_INPUT.pr, headRef: 'release/v1.5.0' } },
            { reader, octokit },
        );
        expect(outcome).toEqual({ kind: 'skipped', reason: 'release-branch' });
        expect(calls.listForRepo).not.toHaveBeenCalled();
    });

    it('skips when PR base is not the production branch (staging/dev merges)', async () => {
        const reader = new FakeGitHubReader({});
        const { octokit, calls } = fakeIssuesOctokit();
        const outcome = await manageReleaseIssue(
            { ...BASE_INPUT, pr: { ...BASE_INPUT.pr, baseRef: 'staging' } },
            { reader, octokit },
        );
        expect(outcome).toEqual({ kind: 'skipped', reason: 'non-production' });
        expect(calls.listForRepo).not.toHaveBeenCalled();
    });

    it('still opens the issue from the webhook payload when the Search API lags', async () => {
        // Regression test: the webhook fired seconds after merge, so the Search
        // index that backs listMergedPRs returns [] (the just-merged PR is not
        // indexed yet). We must STILL open the issue, seeding the triggering PR
        // straight from the event payload — otherwise low-traffic repos never
        // get a release issue (there's no "next merge" to repair it).
        const reader = new FakeGitHubReader({
            tags: [{ name: 'v0.5.0', sha: 's', commitDate: '2026-05-01T00:00:00Z' }],
            mergedPRs: [],
        });
        const { octokit, calls } = fakeIssuesOctokit({ listForRepoData: [] });
        const outcome = await manageReleaseIssue(BASE_INPUT, { reader, octokit });
        expect(outcome.kind).toBe('created');
        expect(calls.create).toHaveBeenCalledTimes(1);
        // The triggering PR (#42, from the payload) is in the rendered body.
        const createArgs = firstCallArg<{ body: string }>(calls.create);
        expect(createArgs.body).toContain('#42');
    });
});

describe('manageReleaseIssue — create new issue', () => {
    it('creates a new release issue when none exists', async () => {
        const reader = new FakeGitHubReader({
            tags: [{ name: 'v0.5.0', sha: 's', commitDate: '2026-05-01T00:00:00Z' }],
            mergedPRs: [
                {
                    number: 42,
                    title: 'feat: cool thing',
                    body: '',
                    url: 'u',
                    author: 'octocat',
                    mergedAt: '2026-05-20T10:00:00Z',
                    baseRef: 'main',
                    headRef: 'feature/x',
                },
            ],
        });
        const { octokit, calls } = fakeIssuesOctokit({ listForRepoData: [] });
        const outcome = await manageReleaseIssue(BASE_INPUT, { reader, octokit });
        expect(outcome).toEqual({ kind: 'created', issueNumber: 999 });
        expect(calls.create).toHaveBeenCalledTimes(1);
        expect(calls.update).not.toHaveBeenCalled();
        // ensureReleaseLabel ran on the create path
        expect(calls.getLabel).toHaveBeenCalledTimes(1);
    });

    it('correctly threads lastTag=null when the repo has never released', async () => {
        const reader = new FakeGitHubReader({
            tags: [],
            mergedPRs: [
                {
                    number: 1,
                    title: 'feat: first PR',
                    body: '',
                    url: 'u',
                    author: 'a',
                    mergedAt: '2026-01-01T00:00:00Z',
                    baseRef: 'main',
                    headRef: 'f1',
                },
            ],
        });
        const { octokit, calls } = fakeIssuesOctokit({ listForRepoData: [] });
        const outcome = await manageReleaseIssue(BASE_INPUT, { reader, octokit });
        expect(outcome.kind).toBe('created');
        const createArgs = firstCallArg<{ title: string; body: string }>(calls.create);
        // "since the first release" wording, not a tag reference.
        expect(createArgs.title).toContain('since the first release');
        expect(createArgs.body).toContain('"lastTag":null');
    });
});

describe('manageReleaseIssue — update existing issue', () => {
    it('updates the existing release issue when one is open', async () => {
        const marker = encodeMarker({ v: 1, branch: 'main', lastTag: 'v0.5.0' });
        const reader = new FakeGitHubReader({
            tags: [{ name: 'v0.5.0', sha: 's', commitDate: '2026-05-01T00:00:00Z' }],
            mergedPRs: [
                {
                    number: 42,
                    title: 'feat: cool thing',
                    body: '',
                    url: 'u',
                    author: 'a',
                    mergedAt: '2026-05-20T10:00:00Z',
                    baseRef: 'main',
                    headRef: 'feature/x',
                },
                {
                    number: 43,
                    title: 'fix: bug',
                    body: '',
                    url: 'u',
                    author: 'b',
                    mergedAt: '2026-05-21T10:00:00Z',
                    baseRef: 'main',
                    headRef: 'feature/y',
                },
            ],
        });
        const { octokit, calls } = fakeIssuesOctokit({
            listForRepoData: [
                {
                    number: 88,
                    title: '🚀 Release pending — 1 change since v0.5.0',
                    body: `existing body ${marker}`,
                    state: 'open',
                },
            ],
        });
        const outcome = await manageReleaseIssue(BASE_INPUT, { reader, octokit });
        expect(outcome).toEqual({ kind: 'updated', issueNumber: 88 });
        expect(calls.create).not.toHaveBeenCalled();
        expect(calls.update).toHaveBeenCalledTimes(1);
        const updateArgs = firstCallArg<{
            issue_number: number;
            title: string;
            body: string;
        }>(calls.update);
        expect(updateArgs.issue_number).toBe(88);
        // Both PRs are present in the rendered body, with title-count updated.
        expect(updateArgs.title).toContain('2 changes');
        expect(updateArgs.body).toContain('#42');
        expect(updateArgs.body).toContain('#43');
    });

    it('does NOT match an issue with the label but missing the marker (manual label)', async () => {
        // Defense against a maintainer attaching the label to an unrelated
        // issue. With no marker, findOpenReleaseIssue returns null → we go
        // down the create path instead of clobbering the unrelated issue.
        const reader = new FakeGitHubReader({
            tags: [],
            mergedPRs: [
                {
                    number: 1,
                    title: 'feat: thing',
                    body: '',
                    url: 'u',
                    author: 'a',
                    mergedAt: '2026-05-20T10:00:00Z',
                    baseRef: 'main',
                    headRef: 'f1',
                },
            ],
        });
        const { octokit, calls } = fakeIssuesOctokit({
            listForRepoData: [
                {
                    number: 100,
                    title: 'unrelated labeled issue',
                    body: 'no marker',
                    state: 'open',
                },
            ],
        });
        const outcome = await manageReleaseIssue(BASE_INPUT, { reader, octokit });
        // We opened a fresh issue rather than updating the mislabeled one.
        expect(outcome.kind).toBe('created');
        expect(calls.update).not.toHaveBeenCalled();
        expect(calls.create).toHaveBeenCalledTimes(1);
    });
});
