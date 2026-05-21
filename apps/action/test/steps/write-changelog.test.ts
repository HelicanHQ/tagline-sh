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

    it('writes per-package CHANGELOGs with package-specific content (M3)', async () => {
        await fs.mkdir(path.join(dir, 'packages/api'), { recursive: true });
        await fs.mkdir(path.join(dir, 'packages/ui'), { recursive: true });

        // `db` isn't in plan.packages — its CHANGELOG should not be created.
        await fs.mkdir(path.join(dir, 'packages/db'), { recursive: true });

        const plan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-2026-05-19',
            changelogContent:
                '## [event-2026-05-19] - 2026-05-19\n\nReleased:\n\n- `api@1.1.0`\n- `ui@0.5.1`\n',
            packages: [
                {
                    name: 'api',
                    path: 'packages/api',
                    packageJsonPath: 'packages/api/package.json',
                    changelogPath: 'packages/api/CHANGELOG.md',
                    currentVersion: '1.0.0',
                    nextVersion: '1.1.0',
                    bumpType: 'minor',
                    prs: [],
                    changelogContent: '## [1.1.0] - 2026-05-19\n\n### Added\n\n- api feature\n',
                    tagName: 'api@1.1.0',
                },
                {
                    name: 'ui',
                    path: 'packages/ui',
                    packageJsonPath: 'packages/ui/package.json',
                    changelogPath: 'packages/ui/CHANGELOG.md',
                    currentVersion: '0.5.0',
                    nextVersion: '0.5.1',
                    bumpType: 'patch',
                    prs: [],
                    changelogContent: '## [0.5.1] - 2026-05-19\n\n### Fixed\n\n- ui bug\n',
                    tagName: 'ui@0.5.1',
                },
            ],
        });

        const result = await writeChangelog(plan, dir);
        expect(result.files).toContain('packages/api/CHANGELOG.md');
        expect(result.files).toContain('packages/ui/CHANGELOG.md');
        // db was never in plan.packages → its CHANGELOG isn't touched.
        expect(result.files).not.toContain('packages/db/CHANGELOG.md');
        expect(result.files).toContain('CHANGELOG.md');

        // Each per-package CHANGELOG gets ITS OWN content, not the aggregate.
        const apiClog = await fs.readFile(
            path.join(dir, 'packages/api/CHANGELOG.md'),
            'utf8',
        );
        expect(apiClog).toContain('## [1.1.0]');
        expect(apiClog).toContain('api feature');
        expect(apiClog).not.toContain('ui bug');

        const uiClog = await fs.readFile(path.join(dir, 'packages/ui/CHANGELOG.md'), 'utf8');
        expect(uiClog).toContain('## [0.5.1]');
        expect(uiClog).toContain('ui bug');
        expect(uiClog).not.toContain('api feature');

        // Root CHANGELOG carries the release-event aggregator.
        const rootClog = await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
        expect(rootClog).toContain('event-2026-05-19');
        expect(rootClog).toContain('api@1.1.0');
        expect(rootClog).toContain('ui@0.5.1');
    });

    // Regression: the transitive case the existing tests don't cover. Two
    // consecutive runs of writeChangelog (i.e. two consecutive Tagline-cut
    // releases against the same repo) must both survive in the on-disk
    // CHANGELOG. A bug where the second run accidentally truncates the first
    // would pass every other test in this file — but would silently overwrite
    // changelog history in production after the second release.
    it('preserves prior entries across consecutive single-repo releases', async () => {
        // First release: v1.5.0 (no prior CHANGELOG on disk).
        await writeChangelog(makePlan(), dir);

        // Second release: v1.5.1 — note the new changelogContent.
        await writeChangelog(
            makePlan({
                currentVersion: '1.5.0',
                nextVersion: '1.5.1',
                lastTag: 'v1.5.0',
                changelogContent:
                    '## [1.5.1] - 2026-05-20\n\n### Fixed\n\n- post-1.5.0 hotfix ([#43](https://gh/pr/43))\n',
            }),
            dir,
        );

        const content = await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
        const idx150 = content.indexOf('## [1.5.0]');
        const idx151 = content.indexOf('## [1.5.1]');
        expect(idx151).toBeGreaterThan(-1);
        expect(idx150).toBeGreaterThan(-1);
        // Newer entry must appear above older entry.
        expect(idx151).toBeLessThan(idx150);
        // The Keep-a-Changelog header must still be present and not duplicated.
        expect(content.match(/# Changelog/g)?.length).toBe(1);
    });

    it('preserves prior entries across consecutive monorepo releases (per-package + root)', async () => {
        await fs.mkdir(path.join(dir, 'packages/api'), { recursive: true });
        await fs.mkdir(path.join(dir, 'packages/ui'), { recursive: true });

        const firstPlan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-2026-05-19',
            changelogContent:
                '## [event-2026-05-19] - 2026-05-19\n\nReleased:\n\n- `api@1.1.0`\n',
            packages: [
                {
                    name: 'api',
                    path: 'packages/api',
                    packageJsonPath: 'packages/api/package.json',
                    changelogPath: 'packages/api/CHANGELOG.md',
                    currentVersion: '1.0.0',
                    nextVersion: '1.1.0',
                    bumpType: 'minor',
                    prs: [],
                    changelogContent: '## [1.1.0] - 2026-05-19\n\n### Added\n\n- api feature\n',
                    tagName: 'api@1.1.0',
                },
            ],
        });

        const secondPlan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-2026-05-20',
            changelogContent:
                '## [event-2026-05-20] - 2026-05-20\n\nReleased:\n\n- `api@1.1.1`\n',
            packages: [
                {
                    name: 'api',
                    path: 'packages/api',
                    packageJsonPath: 'packages/api/package.json',
                    changelogPath: 'packages/api/CHANGELOG.md',
                    currentVersion: '1.1.0',
                    nextVersion: '1.1.1',
                    bumpType: 'patch',
                    prs: [],
                    changelogContent: '## [1.1.1] - 2026-05-20\n\n### Fixed\n\n- api hotfix\n',
                    tagName: 'api@1.1.1',
                },
            ],
        });

        await writeChangelog(firstPlan, dir);
        await writeChangelog(secondPlan, dir);

        // Per-package CHANGELOG must show BOTH entries, newer first.
        const apiClog = await fs.readFile(path.join(dir, 'packages/api/CHANGELOG.md'), 'utf8');
        const apiIdx110 = apiClog.indexOf('## [1.1.0]');
        const apiIdx111 = apiClog.indexOf('## [1.1.1]');
        expect(apiIdx111).toBeGreaterThan(-1);
        expect(apiIdx110).toBeGreaterThan(-1);
        expect(apiIdx111).toBeLessThan(apiIdx110);

        // Root aggregator CHANGELOG must show BOTH release events, newer first.
        const rootClog = await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8');
        const rootIdx19 = rootClog.indexOf('event-2026-05-19');
        const rootIdx20 = rootClog.indexOf('event-2026-05-20');
        expect(rootIdx20).toBeGreaterThan(-1);
        expect(rootIdx19).toBeGreaterThan(-1);
        expect(rootIdx20).toBeLessThan(rootIdx19);
    });
});
