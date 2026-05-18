import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeChangelog } from '../../src/steps/write-changelog.js';
import { makePlan } from '../fixtures/plan.js';

describe('writeChangelog', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagline-clog-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('creates a fresh CHANGELOG.md when none exists', async () => {
        const result = await writeChangelog(makePlan(), dir);
        expect(result.files).toEqual(['CHANGELOG.md']);
        const content = await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
        expect(content).toContain('# Changelog');
        expect(content).toContain('Keep a Changelog');
        expect(content).toContain('## [1.5.0]');
    });

    it('prepends in front of the first existing entry', async () => {
        await fs.writeFile(
            path.join(dir, 'CHANGELOG.md'),
            '# Changelog\n\n## [1.4.2] - 2026-04-28\n\n### Fixed\n\n- old fix\n',
            'utf8',
        );
        await writeChangelog(makePlan(), dir);
        const content = await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
        const idxNew = content.indexOf('## [1.5.0]');
        const idxOld = content.indexOf('## [1.4.2]');
        expect(idxNew).toBeGreaterThan(-1);
        expect(idxOld).toBeGreaterThan(idxNew);
    });

    it('writes per-package CHANGELOGs in monorepos, only for affected packages', async () => {
        await fs.mkdir(path.join(dir, 'packages/api'), { recursive: true });
        await fs.mkdir(path.join(dir, 'packages/ui'), { recursive: true });

        const plan = makePlan({
            isMonorepo: true,
            monorepoInfo: {
                type: 'pnpm-workspaces',
                packages: [
                    {
                        name: 'api',
                        path: 'packages/api',
                        currentVersion: '1.0.0',
                        packageJsonPath: 'packages/api/package.json',
                        changelogPath: 'packages/api/CHANGELOG.md',
                        affectedPRs: [
                            {
                                number: 7,
                                title: 'feat(api): X',
                                url: 'u',
                                author: 'oct',
                                mergedAt: 't',
                                commits: [],
                                tickets: [],
                                suggestedBump: 'minor',
                                bodyExcerpt: null,
                            },
                        ],
                    },
                    {
                        name: 'ui',
                        path: 'packages/ui',
                        currentVersion: '0.5.0',
                        packageJsonPath: 'packages/ui/package.json',
                        changelogPath: 'packages/ui/CHANGELOG.md',
                        affectedPRs: [],
                    },
                ],
                rootPackage: null,
            },
        });

        const result = await writeChangelog(plan, dir);
        expect(result.files).toContain('packages/api/CHANGELOG.md');
        expect(result.files).not.toContain('packages/ui/CHANGELOG.md');
        expect(result.files).toContain('CHANGELOG.md');

        const apiClog = await fs.readFile(path.join(dir, 'packages/api/CHANGELOG.md'), 'utf8');
        expect(apiClog).toContain('## [1.5.0]');
    });
});
