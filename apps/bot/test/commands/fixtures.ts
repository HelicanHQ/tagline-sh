import type { ReleasePlan, ReleaseSummary } from '@tagline-sh/shared';

const FIXTURE_SUMMARY: ReleaseSummary = {
    version: '1.5.0',
    date: 'May 18, 2026',
    headline: 'Fixture release summary headline.',
    body: 'Fixture release summary body. Two sentences for realism.',
    highlights: ['Fixture highlight 1', 'Fixture highlight 2'],
    rawMarkdown:
        "## What's new in v1.5.0 · May 18, 2026\n\nFixture release summary headline.\n\nFixture release summary body. Two sentences for realism.\n\n- Fixture highlight 1\n- Fixture highlight 2",
};

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
        changelogContent: '## [1.5.0]\n',
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
