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
    releaseSummary: {
        version: '1.5.0',
        date: 'May 18, 2026',
        headline: 'You can now log in with OAuth2 PKCE.',
        body: 'This release adds OAuth2 PKCE support so users can sign in more securely.',
        highlights: ['Sign in with OAuth2 PKCE'],
        rawMarkdown:
            "## What's new in v1.5.0 · May 18, 2026\n\nYou can now log in with OAuth2 PKCE.\n\nThis release adds OAuth2 PKCE support so users can sign in more securely.\n\n- Sign in with OAuth2 PKCE",
    },
    packages: [],
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

    it('rejects a zero-padded nextVersion (npm forbids leading zeros)', () => {
        const bad = { ...goodPlan, nextVersion: '2026.06.0' };
        expect(() => ReleasePlanSchema.parse(bad)).toThrow(/leading zeros|zero-padded/);
    });

    it('rejects a zero-padded nextVersion on a package plan', () => {
        const bad = {
            ...goodPlan,
            isMonorepo: true,
            packages: [
                {
                    name: '@acme/api',
                    path: 'packages/api',
                    packageJsonPath: 'packages/api/package.json',
                    changelogPath: 'packages/api/CHANGELOG.md',
                    currentVersion: '2026.6.0',
                    nextVersion: '2026.06.1',
                    bumpType: 'minor' as const,
                    changelogContent: '## [2026.06.1]\n',
                    tagName: '@acme/api@2026.06.1',
                },
            ],
        };
        expect(() => ReleasePlanSchema.parse(bad)).toThrow(/leading zeros|zero-padded/);
    });

    it('accepts an unpadded calver nextVersion', () => {
        expect(() =>
            ReleasePlanSchema.parse({ ...goodPlan, nextVersion: '2026.6.0' }),
        ).not.toThrow();
    });

    it('accepts a bare incremental nextVersion (not semver, but npm-publishable)', () => {
        expect(() => ReleasePlanSchema.parse({ ...goodPlan, nextVersion: '42' })).not.toThrow();
    });

    it('accepts a calver prerelease nextVersion', () => {
        expect(() =>
            ReleasePlanSchema.parse({ ...goodPlan, nextVersion: '2026.6.1-rc.0' }),
        ).not.toThrow();
    });

    it('rejects a non-string url in a PR', () => {
        const bad = {
            ...goodPlan,
            prs: [{ ...goodPlan.prs[0], url: 'not-a-url' }],
        };
        expect(() => ReleasePlanSchema.parse(bad)).toThrow();
    });

    it('rejects a plan missing releaseSummary', () => {
        const { releaseSummary: _omit, ...bad } = goodPlan;
        expect(() => ReleasePlanSchema.parse(bad)).toThrow();
    });

    it('accepts a slim transport plan with prs/monorepoInfo omitted (defaults applied)', () => {
        // The bot strips prs + monorepoInfo + packages[].prs before dispatch
        // to fit under GitHub's workflow_dispatch input size limit. The
        // schema must accept that shape and fill the defaults so the action
        // sees identical structure either way.
        const { prs: _droppedPRs, monorepoInfo: _droppedMRI, ...slim } = goodPlan;
        const parsed = ReleasePlanSchema.parse(slim);
        expect(parsed.prs).toEqual([]);
        expect(parsed.monorepoInfo).toBeNull();
        // Canonical fields the action consumes survive the slimming intact.
        expect(parsed.changelogContent).toBe(goodPlan.changelogContent);
        expect(parsed.releaseSummary).toEqual(goodPlan.releaseSummary);
    });

    it('accepts a slim transport plan with packages[].prs omitted (defaults applied)', () => {
        const monorepoPlan = {
            ...goodPlan,
            isMonorepo: true,
            packages: [
                {
                    name: '@acme/api',
                    path: 'packages/api',
                    packageJsonPath: 'packages/api/package.json',
                    changelogPath: 'packages/api/CHANGELOG.md',
                    currentVersion: '1.0.0',
                    nextVersion: '1.1.0',
                    bumpType: 'minor' as const,
                    // prs intentionally omitted — the slim shape from the bot.
                    changelogContent: '## [1.1.0]\n',
                    tagName: '@acme/api@1.1.0',
                },
            ],
        };
        const parsed = ReleasePlanSchema.parse(monorepoPlan);
        expect(parsed.packages[0]!.prs).toEqual([]);
        expect(parsed.packages[0]!.changelogContent).toBe('## [1.1.0]\n');
    });

    it('rejects a releaseSummary with zero highlights', () => {
        const bad = {
            ...goodPlan,
            releaseSummary: { ...goodPlan.releaseSummary, highlights: [] },
        };
        expect(() => ReleasePlanSchema.parse(bad)).toThrow();
    });

    it('rejects a releaseSummary with more than 5 highlights', () => {
        const bad = {
            ...goodPlan,
            releaseSummary: {
                ...goodPlan.releaseSummary,
                highlights: ['a', 'b', 'c', 'd', 'e', 'f'],
            },
        };
        expect(() => ReleasePlanSchema.parse(bad)).toThrow();
    });
});
