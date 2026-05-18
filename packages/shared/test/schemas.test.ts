import { describe, it, expect } from 'vitest';
import type { ReleasePlan } from '../src/types.js';
import { ReleasePlanSchema, parseReleasePlan } from '../src/schemas.js';

const goodPlan: ReleasePlan = {
    repoOwner: 'acme',
    repoName: 'widget',
    baseBranch: 'main',
    bumpType: 'minor',
    currentVersion: '1.4.2',
    nextVersion: '1.5.0',
    lastTag: 'v1.4.2',
    prs: [
        {
            number: 42,
            title: 'feat(api): add OAuth2 PKCE',
            url: 'https://github.com/acme/widget/pull/42',
            author: 'octocat',
            mergedAt: '2026-05-17T10:00:00Z',
            commits: [
                {
                    type: 'feat',
                    scope: 'api',
                    subject: 'add OAuth2 PKCE',
                    body: null,
                    isBreaking: false,
                    sha: 'abc1234',
                },
            ],
            tickets: ['PROJ-1201'],
            suggestedBump: 'minor',
            bodyExcerpt: 'Adds PKCE support to the auth flow.',
        },
    ],
    changelogContent: '## [1.5.0] - 2026-05-18\n\n### Added\n- PKCE',
    isMonorepo: false,
    monorepoInfo: null,
    isDraft: false,
    isDryRun: false,
    issueNumber: 7,
    approvedBy: 'lead-dev',
    approvedAt: '2026-05-18T09:30:00Z',
};

describe('ReleasePlanSchema', () => {
    it('accepts a known-good plan', () => {
        expect(() => ReleasePlanSchema.parse(goodPlan)).not.toThrow();
    });

    it('round-trips through JSON without loss', () => {
        const round = parseReleasePlan(JSON.stringify(goodPlan));
        expect(round).toEqual(goodPlan);
    });

    it('rejects an unknown bumpType', () => {
        const bad = { ...goodPlan, bumpType: 'megamajor' };
        expect(() => ReleasePlanSchema.parse(bad)).toThrow();
    });

    it('rejects a missing required field', () => {
        const { repoOwner: _omit, ...bad } = goodPlan;
        expect(() => ReleasePlanSchema.parse(bad)).toThrow();
    });

    it('rejects malformed JSON in parseReleasePlan', () => {
        expect(() => parseReleasePlan('{not json')).toThrow();
    });

    it('rejects a non-string url in a PR', () => {
        const bad = {
            ...goodPlan,
            prs: [{ ...goodPlan.prs[0], url: 'not-a-url' }],
        };
        expect(() => ReleasePlanSchema.parse(bad)).toThrow();
    });
});
