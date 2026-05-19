import type { ReleasePlan, ReleaseSummary } from '@tagline-sh/shared';

const FIXTURE_SUMMARY: ReleaseSummary = {
    version: '1.5.0',
    date: 'May 18, 2026',
    headline: 'Adds the new thing users have been asking for.',
    body: 'This release ships a single user-visible change. Existing flows are unaffected.',
    highlights: ['Added the new thing'],
    rawMarkdown:
        "## What's new in v1.5.0 · May 18, 2026\n\nAdds the new thing users have been asking for.\n\nThis release ships a single user-visible change. Existing flows are unaffected.\n\n- Added the new thing",
};

/**
 * Minimal happy-path plan for tests. Override individual fields per test case.
 */
export function makePlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
    return {
        repoOwner: 'acme',
        repoName: 'widget',
        baseBranch: 'main',
        bumpType: 'minor',
        currentVersion: '1.4.2',
        nextVersion: '1.5.0',
        lastTag: 'v1.4.2',
        prs: [],
        changelogContent:
            '## [1.5.0] - 2026-05-18\n\n### Added\n\n- new thing ([#42](https://gh/pr/42))\n',
        releaseSummary: FIXTURE_SUMMARY,
        isMonorepo: false,
        monorepoInfo: null,
        packages: [],
        isDraft: false,
        isDryRun: false,
        issueNumber: 7,
        approvedBy: 'lead-dev',
        approvedAt: '2026-05-18T09:30:00Z',
        ...overrides,
    };
}
