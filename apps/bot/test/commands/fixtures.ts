import type { ReleasePlan } from '@tagline-sh/shared';

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
        isMonorepo: false,
        monorepoInfo: null,
        isDraft: false,
        isDryRun: false,
        issueNumber: 7,
        approvedBy: 'lead-dev',
        approvedAt: '2026-05-18T09:30:00Z',
        ...overrides,
    };
}
