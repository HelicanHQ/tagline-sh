import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bumpVersion } from '../../src/steps/bump-version.js';
import { makePlan } from '../fixtures/plan.js';

async function makeTempDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'tagline-bump-'));
}

async function readJson(p: string): Promise<{ version?: string }> {
    return JSON.parse(await fs.readFile(p, 'utf8')) as { version?: string };
}

describe('bumpVersion — single repo', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await makeTempDir();
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('updates root package.json#version', async () => {
        await fs.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'demo', version: '1.4.2' }, null, 2),
            'utf8',
        );
        const result = await bumpVersion(makePlan(), dir);
        expect(result.files).toEqual(['package.json']);
        expect((await readJson(path.join(dir, 'package.json'))).version).toBe('1.5.0');
    });

    it('preserves 4-space indentation when present', async () => {
        await fs.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'demo', version: '1.4.2' }, null, 4),
            'utf8',
        );
        await bumpVersion(makePlan(), dir);
        const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
        expect(raw).toContain('    "version"');
    });

    it('does nothing when package.json has no version field', async () => {
        await fs.writeFile(path.join(dir, 'package.json'), '{}', 'utf8');
        const result = await bumpVersion(makePlan(), dir);
        expect(result.files).toEqual([]);
    });
});

describe('bumpVersion — monorepo', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await makeTempDir();
        await fs.mkdir(path.join(dir, 'packages/api'), { recursive: true });
        await fs.mkdir(path.join(dir, 'packages/ui'), { recursive: true });
        await fs.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'root', workspaces: ['packages/*'] }, null, 2),
            'utf8',
        );
        await fs.writeFile(
            path.join(dir, 'packages/api/package.json'),
            JSON.stringify({ name: 'api', version: '1.0.0' }, null, 2),
            'utf8',
        );
        await fs.writeFile(
            path.join(dir, 'packages/ui/package.json'),
            JSON.stringify({ name: 'ui', version: '0.5.0' }, null, 2),
            'utf8',
        );
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('bumps each package to its OWN nextVersion (M3 — no longer all the same)', async () => {
        const plan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-2026-05-19',
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
                    changelogContent: '## [1.1.0]\n',
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
                    changelogContent: '## [0.5.1]\n',
                    tagName: 'ui@0.5.1',
                },
            ],
        });
        const result = await bumpVersion(plan, dir);
        expect(result.files).toEqual([
            'packages/api/package.json',
            'packages/ui/package.json',
        ]);
        // Each package gets its own version, not `plan.nextVersion`.
        expect((await readJson(path.join(dir, 'packages/api/package.json'))).version).toBe(
            '1.1.0',
        );
        expect((await readJson(path.join(dir, 'packages/ui/package.json'))).version).toBe(
            '0.5.1',
        );
    });

    it('skips packages not in plan.packages (independent release cadence)', async () => {
        // `db` is in the workspace but not in plan.packages — should be untouched.
        await fs.mkdir(path.join(dir, 'packages/db'), { recursive: true });
        await fs.writeFile(
            path.join(dir, 'packages/db/package.json'),
            JSON.stringify({ name: 'db', version: '3.0.0' }, null, 2),
            'utf8',
        );
        const plan = makePlan({
            isMonorepo: true,
            nextVersion: 'event-2026-05-19',
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
                    changelogContent: '## [1.1.0]\n',
                    tagName: 'api@1.1.0',
                },
            ],
        });
        await bumpVersion(plan, dir);
        // `db` should still be at 3.0.0
        expect((await readJson(path.join(dir, 'packages/db/package.json'))).version).toBe(
            '3.0.0',
        );
    });
});
