import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeRelease, type ExecutorOctokit } from '../src/release-executor.js';
import { makePlan } from './fixtures/plan.js';

function fakeOctokit(): {
    octokit: ExecutorOctokit;
    calls: {
        createRelease: ReturnType<typeof vi.fn>;
        createPR: ReturnType<typeof vi.fn>;
        createComment: ReturnType<typeof vi.fn>;
    };
} {
    const calls = {
        createRelease: vi.fn(async () => ({
            data: { html_url: 'https://github.com/acme/widget/releases/tag/v1.5.0' },
        })),
        createPR: vi.fn(async () => ({
            data: { html_url: 'https://github.com/acme/widget/pull/100', number: 100 },
        })),
        createComment: vi.fn(async () => ({ data: { html_url: 'comment-url' } })),
    };
    const octokit = {
        rest: {
            repos: { createRelease: calls.createRelease },
            pulls: { create: calls.createPR },
            issues: { createComment: calls.createComment },
        },
    } as unknown as ExecutorOctokit;
    return { octokit, calls };
}

function fakeGit() {
    return {
        addConfig: vi.fn(async () => {}),
        checkoutLocalBranch: vi.fn(async () => {}),
        add: vi.fn(async () => {}),
        commit: vi.fn(async () => ({ commit: 'sha1' })),
        addAnnotatedTag: vi.fn(async () => {}),
        push: vi.fn(async () => {}),
        tags: vi.fn(async () => ({ all: [], latest: '' })),
    };
}

describe('executeRelease — happy path', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagline-exec-'));
        await fs.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'demo', version: '1.4.2' }, null, 2),
            'utf8',
        );
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('runs all steps and returns success with release+pr urls', async () => {
        const { octokit, calls } = fakeOctokit();
        const git = fakeGit();
        const result = await executeRelease(makePlan(), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeRelease>[1]['git'],
        });

        expect(result.success).toBe(true);
        expect(result.tagName).toBe('v1.5.0');
        expect(result.releaseUrl).toContain('/releases/tag/v1.5.0');
        expect(result.prUrl).toContain('/pull/100');

        expect(calls.createRelease).toHaveBeenCalled();
        expect(calls.createPR).toHaveBeenCalled();
        expect(calls.createComment).toHaveBeenCalled();
    });

    it('dry-run skips git/release/PR but still bumps + writes changelog', async () => {
        const { octokit, calls } = fakeOctokit();
        const git = fakeGit();
        const result = await executeRelease(makePlan({ isDryRun: true }), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeRelease>[1]['git'],
        });

        expect(result.success).toBe(true);
        expect(result.isDryRun).toBe(true);
        expect(result.releaseUrl).toBeNull();
        expect(result.prUrl).toBeNull();

        // Filesystem changes still happen so the workflow run can show the diff.
        const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
            version: string;
        };
        expect(pkg.version).toBe('1.5.0');
        expect(await fs.access(path.join(dir, 'CHANGELOG.md')).then(() => true)).toBe(true);

        // No GitHub writes.
        expect(calls.createRelease).not.toHaveBeenCalled();
        expect(calls.createPR).not.toHaveBeenCalled();
        // A "dry run complete" comment still goes out.
        expect(calls.createComment).toHaveBeenCalled();
        const body = calls.createComment.mock.calls[0]?.[0] as { body: string };
        expect(body.body).toContain('dry-run');
    });
});

describe('executeRelease — failure path', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tagline-exec-'));
        await fs.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'demo', version: '1.4.2' }, null, 2),
            'utf8',
        );
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('captures errors, posts a failure comment, and never throws', async () => {
        const { octokit, calls } = fakeOctokit();
        // Force a git failure by returning the tag as already-existing.
        const git = fakeGit();
        git.tags = vi.fn(async () => ({ all: ['v1.5.0'], latest: 'v1.5.0' }));

        const result = await executeRelease(makePlan(), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeRelease>[1]['git'],
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('already exists');

        // Failure comment should still get posted.
        expect(calls.createComment).toHaveBeenCalled();
        const body = calls.createComment.mock.calls[0]?.[0] as { body: string };
        expect(body.body).toContain('failed to release');
    });
});
