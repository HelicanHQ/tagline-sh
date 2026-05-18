import { describe, it, expect } from 'vitest';
import type { ParsedPR } from '@tagline-sh/shared';
import {
    attributePRsToPackages,
    detectMonorepo,
} from '../../src/services/monorepo-detector.js';
import { ANY_REPO, FakeGitHubReader } from '../fixtures/fake-reader.js';

const pkg = (name: string, version: string): string =>
    JSON.stringify({ name, version }, null, 2);

describe('detectMonorepo — flavor detection', () => {
    it('returns type=none for a single repo with only a root package.json', async () => {
        const reader = new FakeGitHubReader({
            files: { 'package.json': pkg('widget', '1.0.0') },
        });
        const info = await detectMonorepo(reader, ANY_REPO);
        expect(info.type).toBe('none');
        expect(info.packages).toEqual([]);
        expect(info.rootPackage?.name).toBe('widget');
    });

    it('detects pnpm-workspaces and expands packages/*', async () => {
        const reader = new FakeGitHubReader({
            files: {
                'package.json': pkg('root', '0.0.0'),
                'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
                'packages/api/package.json': pkg('api', '1.0.0'),
                'packages/web/package.json': pkg('web', '2.0.0'),
            },
            directories: {
                packages: ['api', 'web'],
            },
        });
        const info = await detectMonorepo(reader, ANY_REPO);
        expect(info.type).toBe('pnpm-workspaces');
        expect(info.packages.map((p) => p.name).sort()).toEqual(['api', 'web']);
        expect(info.packages.find((p) => p.name === 'api')?.currentVersion).toBe('1.0.0');
    });

    it('detects turborepo via turbo.json + package.json#workspaces', async () => {
        const reader = new FakeGitHubReader({
            files: {
                'package.json': JSON.stringify({
                    name: 'root',
                    version: '0.0.0',
                    workspaces: ['apps/*', 'packages/*'],
                }),
                'turbo.json': '{}',
                'apps/web/package.json': pkg('web', '1.2.3'),
                'packages/ui/package.json': pkg('ui', '0.1.0'),
            },
            directories: {
                apps: ['web'],
                packages: ['ui'],
            },
        });
        const info = await detectMonorepo(reader, ANY_REPO);
        expect(info.type).toBe('turborepo');
        expect(info.packages.map((p) => p.name).sort()).toEqual(['ui', 'web']);
    });

    it('detects lerna with default packages/* when lerna.json has no list', async () => {
        const reader = new FakeGitHubReader({
            files: {
                'package.json': pkg('root', '0.0.0'),
                'lerna.json': '{}',
                'packages/a/package.json': pkg('a', '1.0.0'),
            },
            directories: { packages: ['a'] },
        });
        const info = await detectMonorepo(reader, ANY_REPO);
        expect(info.type).toBe('lerna');
        expect(info.packages[0]?.name).toBe('a');
    });

    it('falls back to npm-workspaces when only package.json#workspaces is set', async () => {
        const reader = new FakeGitHubReader({
            files: {
                'package.json': JSON.stringify({
                    name: 'root',
                    version: '0.0.0',
                    workspaces: ['packages/*'],
                }),
                'packages/x/package.json': pkg('x', '1.0.0'),
            },
            directories: { packages: ['x'] },
        });
        const info = await detectMonorepo(reader, ANY_REPO);
        expect(info.type).toBe('npm-workspaces');
        expect(info.packages[0]?.name).toBe('x');
    });

    it('identifies yarn-workspaces by packageManager prefix', async () => {
        const reader = new FakeGitHubReader({
            files: {
                'package.json': JSON.stringify({
                    name: 'root',
                    version: '0.0.0',
                    workspaces: ['packages/*'],
                    packageManager: 'yarn@4.5.0',
                }),
                'packages/x/package.json': pkg('x', '1.0.0'),
            },
            directories: { packages: ['x'] },
        });
        const info = await detectMonorepo(reader, ANY_REPO);
        expect(info.type).toBe('yarn-workspaces');
    });
});

describe('attributePRsToPackages', () => {
    const pkgs = [
        {
            name: 'api',
            path: 'packages/api',
            currentVersion: '1.0.0',
            packageJsonPath: 'packages/api/package.json',
            changelogPath: 'packages/api/CHANGELOG.md',
            affectedPRs: [],
        },
        {
            name: 'ui',
            path: 'packages/ui',
            currentVersion: '0.1.0',
            packageJsonPath: 'packages/ui/package.json',
            changelogPath: 'packages/ui/CHANGELOG.md',
            affectedPRs: [],
        },
    ];

    const prA = {
        number: 1,
        title: 'feat(api): X',
        url: 'u',
        author: 'a',
        mergedAt: 't',
        commits: [],
        tickets: [],
        suggestedBump: 'minor',
        bodyExcerpt: null,
    } satisfies ParsedPR;

    const prB = {
        ...prA,
        number: 2,
        title: 'fix(ui): Y',
        suggestedBump: 'patch',
    } satisfies ParsedPR;

    const prC = {
        ...prA,
        number: 3,
        title: 'chore: docs',
        suggestedBump: 'none',
    } satisfies ParsedPR;

    it('routes PRs to packages by file path prefix', () => {
        const out = attributePRsToPackages(
            { type: 'pnpm-workspaces', packages: pkgs, rootPackage: null },
            [
                { pr: prA, files: ['packages/api/src/auth.ts'] },
                { pr: prB, files: ['packages/ui/src/button.tsx'] },
                { pr: prC, files: ['README.md'] },
            ],
        );
        expect(out.packages.find((p) => p.name === 'api')?.affectedPRs).toEqual([prA]);
        expect(out.packages.find((p) => p.name === 'ui')?.affectedPRs).toEqual([prB]);
    });

    it('attributes a multi-package PR to every matching package', () => {
        const out = attributePRsToPackages(
            { type: 'pnpm-workspaces', packages: pkgs, rootPackage: null },
            [{ pr: prA, files: ['packages/api/a.ts', 'packages/ui/b.tsx'] }],
        );
        expect(out.packages.find((p) => p.name === 'api')?.affectedPRs).toEqual([prA]);
        expect(out.packages.find((p) => p.name === 'ui')?.affectedPRs).toEqual([prA]);
    });
});
