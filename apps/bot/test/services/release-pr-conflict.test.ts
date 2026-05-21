import { describe, it, expect, vi } from 'vitest';
import type { ReleasePlan, ReleaseSummary } from '@tagline-sh/shared';
import {
    findOpenReleasePR,
    type ConflictCheckOctokit,
} from '../../src/services/release-pr-conflict.js';

const FIXTURE_SUMMARY: ReleaseSummary = {
    version: '1.5.0',
    date: 'May 21, 2026',
    headline: 'Test.',
    body: 'Body.',
    highlights: ['x'],
    rawMarkdown: '## v1.5.0',
};

function makePlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
    return {
        repoOwner: 'helicanhq',
        repoName: 'tagline-sh',
        baseBranch: 'main',
        bumpType: 'minor',
        currentVersion: '0.0.0',
        nextVersion: '0.1.0',
        lastTag: null,
        prs: [],
        changelogContent: '',
        releaseSummary: FIXTURE_SUMMARY,
        isMonorepo: false,
        monorepoInfo: null,
        packages: [],
        isDraft: false,
        isDryRun: false,
        issueNumber: 5,
        approvedBy: 'moeen-mahmud',
        approvedAt: '2026-05-21T10:34:00Z',
        ...overrides,
    };
}

function makeOctokit(
    pullsListImpl: ConflictCheckOctokit['rest']['pulls']['list'],
): ConflictCheckOctokit {
    return { rest: { pulls: { list: pullsListImpl } } };
}

describe('findOpenReleasePR', () => {
    it('returns null when no open PR exists on the release branch', async () => {
        const octokit = makeOctokit(vi.fn(async () => ({ data: [] })));

        const result = await findOpenReleasePR(makePlan(), octokit);

        expect(result).toBeNull();
    });

    it('returns the open PR number, URL, and branch name when one exists', async () => {
        const octokit = makeOctokit(
            vi.fn(async () => ({
                data: [
                    {
                        number: 42,
                        html_url: 'https://github.com/helicanhq/tagline-sh/pull/42',
                    },
                ],
            })),
        );

        const result = await findOpenReleasePR(makePlan(), octokit);

        expect(result).toEqual({
            number: 42,
            url: 'https://github.com/helicanhq/tagline-sh/pull/42',
            branch: 'release/v0.1.0',
        });
    });

    it('scopes the search to owner:branch — substring matches must not leak in', async () => {
        const pullsList = vi.fn(async () => ({ data: [] }));
        const octokit = makeOctokit(pullsList);

        await findOpenReleasePR(makePlan(), octokit);

        expect(pullsList).toHaveBeenCalledWith({
            owner: 'helicanhq',
            repo: 'tagline-sh',
            head: 'helicanhq:release/v0.1.0',
            state: 'open',
        });
    });

    it('uses the monorepo event-id when nextVersion is date-keyed', async () => {
        // Explicit param typing on the fake so `.mock.calls[0]?.[0]` is the
        // input shape, not `never` from empty-tuple parameter inference.
        const pullsList: ConflictCheckOctokit['rest']['pulls']['list'] = vi.fn(async () => ({
            data: [],
        }));
        const octokit = makeOctokit(pullsList);

        await findOpenReleasePR(makePlan({ nextVersion: 'event-2026-05-21' }), octokit);

        const mockCalls = (pullsList as unknown as { mock: { calls: Array<[unknown]> } }).mock
            .calls;
        const args = mockCalls[0]?.[0] as { head?: string } | undefined;
        expect(args?.head).toBe('helicanhq:release/vevent-2026-05-21');
    });
});
