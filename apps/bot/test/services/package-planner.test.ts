import { describe, it, expect } from 'vitest';
import type { BumpType, MonorepoInfo, ParsedPR, RepoConfig } from '@tagline-sh/shared';
import { DEFAULT_CONFIG } from '@tagline-sh/shared';
import {
    buildPackagePlans,
    monorepoEventId,
} from '../../src/services/package-planner.js';

function makePR(opts: { number: number; bump: BumpType; commitType?: string }): ParsedPR {
    return {
        number: opts.number,
        title: `PR ${opts.number}`,
        url: `https://github.com/x/y/pull/${opts.number}`,
        author: 'oct',
        mergedAt: '2026-05-19T10:00:00Z',
        commits: [
            {
                type: (opts.commitType ?? 'feat') as ParsedPR['commits'][number]['type'],
                scope: null,
                subject: 'x',
                body: null,
                isBreaking: false,
                sha: `c${opts.number}`,
            },
        ],
        tickets: [],
        suggestedBump: opts.bump,
        bodyExcerpt: null,
    };
}

function semverMonorepo(opts: {
    api?: { current: string; prs: ParsedPR[] };
    ui?: { current: string; prs: ParsedPR[] };
    db?: { current: string; prs: ParsedPR[] };
}): MonorepoInfo {
    const packages = [] as MonorepoInfo['packages'];
    if (opts.api) {
        packages.push({
            name: '@acme/api',
            path: 'packages/api',
            packageJsonPath: 'packages/api/package.json',
            changelogPath: 'packages/api/CHANGELOG.md',
            currentVersion: opts.api.current,
            affectedPRs: opts.api.prs,
        });
    }
    if (opts.ui) {
        packages.push({
            name: '@acme/ui',
            path: 'packages/ui',
            packageJsonPath: 'packages/ui/package.json',
            changelogPath: 'packages/ui/CHANGELOG.md',
            currentVersion: opts.ui.current,
            affectedPRs: opts.ui.prs,
        });
    }
    if (opts.db) {
        packages.push({
            name: '@acme/db',
            path: 'packages/db',
            packageJsonPath: 'packages/db/package.json',
            changelogPath: 'packages/db/CHANGELOG.md',
            currentVersion: opts.db.current,
            affectedPRs: opts.db.prs,
        });
    }
    return { type: 'pnpm-workspaces', packages, rootPackage: null };
}

const semverConfig: RepoConfig = DEFAULT_CONFIG;

describe('buildPackagePlans — semver', () => {
    it('produces one plan per package that has PRs, with per-package nextVersions', () => {
        const info = semverMonorepo({
            api: { current: '1.0.0', prs: [makePR({ number: 71, bump: 'minor' })] },
            ui: { current: '0.5.0', prs: [makePR({ number: 72, bump: 'patch' })] },
        });
        const plans = buildPackagePlans({
            monorepoInfo: info,
            branch: 'main',
            config: semverConfig,
        });

        expect(plans).toHaveLength(2);
        const api = plans.find((p) => p.name === '@acme/api')!;
        const ui = plans.find((p) => p.name === '@acme/ui')!;
        expect(api.currentVersion).toBe('1.0.0');
        expect(api.nextVersion).toBe('1.1.0');
        expect(api.bumpType).toBe('minor');
        expect(api.tagName).toBe('@acme/api@1.1.0');
        expect(ui.currentVersion).toBe('0.5.0');
        expect(ui.nextVersion).toBe('0.5.1');
        expect(ui.tagName).toBe('@acme/ui@0.5.1');
    });

    it("excludes packages with no PRs (the database isn't released today)", () => {
        const info = semverMonorepo({
            api: { current: '1.0.0', prs: [makePR({ number: 71, bump: 'minor' })] },
            db: { current: '3.0.0', prs: [] }, // no PRs touched db
        });
        const plans = buildPackagePlans({
            monorepoInfo: info,
            branch: 'main',
            config: semverConfig,
        });
        expect(plans).toHaveLength(1);
        expect(plans[0]!.name).toBe('@acme/api');
    });

    it('excludes packages whose aggregated bump is none (semver only)', () => {
        const info = semverMonorepo({
            api: {
                current: '1.0.0',
                prs: [makePR({ number: 71, bump: 'none', commitType: 'chore' })],
            },
        });
        const plans = buildPackagePlans({
            monorepoInfo: info,
            branch: 'main',
            config: semverConfig,
        });
        expect(plans).toHaveLength(0);
    });

    it('applies per-package bumpOverrides, INCLUDING re-including bump=none packages', () => {
        const info = semverMonorepo({
            api: {
                current: '1.0.0',
                prs: [makePR({ number: 71, bump: 'none', commitType: 'chore' })],
            },
            ui: { current: '0.5.0', prs: [makePR({ number: 72, bump: 'minor' })] },
        });
        const plans = buildPackagePlans({
            monorepoInfo: info,
            branch: 'main',
            config: semverConfig,
            bumpOverrides: new Map([['@acme/api', 'patch' as BumpType]]),
        });
        expect(plans).toHaveLength(2);
        const api = plans.find((p) => p.name === '@acme/api')!;
        expect(api.nextVersion).toBe('1.0.1');
        expect(api.bumpType).toBe('patch');
    });

    it('renders a deterministic per-package changelog entry referencing only that package\'s PRs', () => {
        const info = semverMonorepo({
            api: { current: '1.0.0', prs: [makePR({ number: 71, bump: 'minor' })] },
            ui: { current: '0.5.0', prs: [makePR({ number: 72, bump: 'patch' })] },
        });
        const plans = buildPackagePlans({
            monorepoInfo: info,
            branch: 'main',
            config: semverConfig,
        });
        const api = plans.find((p) => p.name === '@acme/api')!;
        const ui = plans.find((p) => p.name === '@acme/ui')!;
        expect(api.changelogContent).toContain('## [1.1.0]');
        expect(api.changelogContent).toContain('[#71]');
        expect(api.changelogContent).not.toContain('[#72]');
        expect(ui.changelogContent).toContain('## [0.5.1]');
        expect(ui.changelogContent).toContain('[#72]');
        expect(ui.changelogContent).not.toContain('[#71]');
    });
});

describe('buildPackagePlans — calver/incremental include ANY package with PRs', () => {
    const calverConfig: RepoConfig = {
        ...DEFAULT_CONFIG,
        versioning: { scheme: 'calver', pattern: 'YYYY.MM.MICRO' },
    };

    it('includes a chore-only package on calver (mechanical math)', () => {
        const info = semverMonorepo({
            api: {
                current: '2026.4.0',
                prs: [makePR({ number: 71, bump: 'none', commitType: 'chore' })],
            },
        });
        const plans = buildPackagePlans({
            monorepoInfo: info,
            branch: 'main',
            config: calverConfig,
            now: new Date(Date.UTC(2026, 4, 19, 12, 0, 0)),
        });
        expect(plans).toHaveLength(1);
        // April → May → MICRO resets, but the test config uses 'MM' so:
        // 2026.4.0 → next on May 19 → 2026.5.0 (month changed).
        expect(plans[0]!.nextVersion).toBe('2026.5.0');
    });

    it('per-package MICRO increments independently (the user\'s key example)', () => {
        // api had its first May release (MICRO=0); ui hasn't released in May yet.
        // Today both ship.
        const info = semverMonorepo({
            api: { current: '2026.5.0', prs: [makePR({ number: 71, bump: 'minor' })] },
            ui: { current: '2026.4.0', prs: [makePR({ number: 72, bump: 'patch' })] },
        });
        const plans = buildPackagePlans({
            monorepoInfo: info,
            branch: 'main',
            config: calverConfig,
            now: new Date(Date.UTC(2026, 4, 19, 12, 0, 0)),
        });
        const api = plans.find((p) => p.name === '@acme/api')!;
        const ui = plans.find((p) => p.name === '@acme/ui')!;
        // api was last released in May, MICRO increments: 2026.5.0 → 2026.5.1
        expect(api.nextVersion).toBe('2026.5.1');
        // ui was last released in April, MICRO resets: 2026.4.0 → 2026.5.0
        expect(ui.nextVersion).toBe('2026.5.0');
    });
});

describe('monorepoEventId', () => {
    it('returns event-YYYY-MM-DD in UTC', () => {
        const id = monorepoEventId(new Date(Date.UTC(2026, 4, 19, 23, 30, 0)));
        expect(id).toBe('event-2026-05-19');
    });
});
