import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    executeProposeRelease,
    executeFinalizeRelease,
    type ExecutorOctokit,
} from '../src/release-executor.js';
import { extractFinalizePlan, encodeFinalizePlan } from '../src/steps/open-pr.js';
import { makePlan } from './fixtures/plan.js';

function fakeOctokit(): {
    octokit: ExecutorOctokit;
    calls: {
        createRelease: ReturnType<typeof vi.fn>;
        createPR: ReturnType<typeof vi.fn>;
        createComment: ReturnType<typeof vi.fn>;
        createRef: ReturnType<typeof vi.fn>;
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
        createRef: vi.fn(async (params: { ref: string }) => ({ data: { ref: params.ref } })),
    };
    const octokit = {
        rest: {
            repos: { createRelease: calls.createRelease },
            pulls: { create: calls.createPR },
            issues: { createComment: calls.createComment },
            git: { createRef: calls.createRef },
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
        push: vi.fn(async () => {}),
    };
}

describe('executeProposeRelease — happy path (Phase A)', () => {
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

    it('bumps + writes changelog + opens PR, but does NOT create tag or GitHub Release', async () => {
        const { octokit, calls } = fakeOctokit();
        const git = fakeGit();
        const result = await executeProposeRelease(makePlan(), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeProposeRelease>[1]['git'],
        });

        expect(result.success).toBe(true);
        expect(result.tagName).toBe('v1.5.0');
        expect(result.prUrl).toContain('/pull/100');
        // Critical: NO release URL because no GitHub Release was created.
        expect(result.releaseUrl).toBeNull();

        expect(calls.createPR).toHaveBeenCalled();
        expect(calls.createComment).toHaveBeenCalled();
        // The bug fix: these must not fire during propose phase.
        expect(calls.createRelease).not.toHaveBeenCalled();
        expect(calls.createRef).not.toHaveBeenCalled();
    });

    it('embeds a parseable plan marker in the PR body', async () => {
        const { octokit, calls } = fakeOctokit();
        const git = fakeGit();
        await executeProposeRelease(makePlan(), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeProposeRelease>[1]['git'],
        });

        const prCall = calls.createPR.mock.calls[0]?.[0] as { body: string };
        expect(prCall.body).toContain('<!-- tagline-plan-v1');

        const decoded = extractFinalizePlan(prCall.body);
        expect(decoded).not.toBeNull();
        expect(decoded?.tags).toEqual(['v1.5.0']);
        expect(decoded?.nextVersion).toBe('1.5.0');
        // The release body inside the payload is what Phase B will publish.
        expect(decoded?.releaseBodies[0]).toContain("What's new in v1.5.0");
    });

    it("acknowledgement comment frames the release as a PROPOSAL, not a publication", async () => {
        const { octokit, calls } = fakeOctokit();
        const git = fakeGit();
        await executeProposeRelease(makePlan(), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeProposeRelease>[1]['git'],
        });

        const body = (calls.createComment.mock.calls[0]?.[0] as { body: string }).body;
        expect(body).toContain('prepared the release');
        expect(body).toMatch(/merge.*publish/i);
        expect(body).toContain('Preview (will publish on merge)');
        // Should NOT claim the release is live.
        expect(body).not.toContain('released `v1.5.0` 🎉');
    });

    it('dry-run skips git/PR writes but still bumps + writes changelog locally', async () => {
        const { octokit, calls } = fakeOctokit();
        const git = fakeGit();
        const result = await executeProposeRelease(makePlan({ isDryRun: true }), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeProposeRelease>[1]['git'],
        });

        expect(result.success).toBe(true);
        expect(result.isDryRun).toBe(true);
        expect(result.prUrl).toBeNull();
        expect(result.releaseUrl).toBeNull();

        const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
            version: string;
        };
        expect(pkg.version).toBe('1.5.0');

        expect(calls.createPR).not.toHaveBeenCalled();
        expect(calls.createRelease).not.toHaveBeenCalled();
        expect(calls.createComment).toHaveBeenCalled();
    });
});

describe('executeFinalizeRelease — happy path (Phase B)', () => {
    function makePRBody(): string {
        const payload = encodeFinalizePlan({
            nextVersion: '1.5.0',
            tags: ['v1.5.0'],
            releaseBodies: ['## v1.5.0\n\nReleased!'],
            releaseNames: ['v1.5.0'],
            draft: false,
            issueNumber: 0,
            summaryMarkdown: "## What's new in v1.5.0\n\n- Added the new thing",
        });
        return [
            '## Plain-language summary',
            '',
            '---',
            '',
            '## [1.5.0]',
            '',
            '<!-- tagline-plan-v1',
            payload,
            '-->',
        ].join('\n');
    }

    it('creates the tag at the merge SHA, creates the GitHub Release, comments on the PR', async () => {
        const { octokit, calls } = fakeOctokit();
        const result = await executeFinalizeRelease(
            {
                repoOwner: 'acme',
                repoName: 'widget',
                mergeSha: 'merge-sha-deadbeef',
                prNumber: 42,
                prBody: makePRBody(),
                headRef: 'release/v1.5.0',
            },
            { octokit, workspaceRoot: '/tmp' },
        );

        expect(result.success).toBe(true);
        expect(result.tagName).toBe('v1.5.0');
        expect(result.releaseUrl).toContain('/releases/tag/v1.5.0');

        // Tag was created via the git refs API at the exact merge SHA.
        expect(calls.createRef).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'widget',
            ref: 'refs/tags/v1.5.0',
            sha: 'merge-sha-deadbeef',
        });

        // GitHub Release was published.
        expect(calls.createRelease).toHaveBeenCalled();
        const relCall = calls.createRelease.mock.calls[0]?.[0] as { tag_name: string; body: string };
        expect(relCall.tag_name).toBe('v1.5.0');
        expect(relCall.body).toContain('Released!');

        // Completion comment posted on the merged PR (issue_number=42).
        const commentCall = calls.createComment.mock.calls[0]?.[0] as {
            issue_number: number;
            body: string;
        };
        expect(commentCall.issue_number).toBe(42);
        expect(commentCall.body).toContain('Released `v1.5.0` 🎉');
        expect(commentCall.body).toContain('Ready to share');
    });

    it('fails clearly when the PR body has no plan marker (manual PR or edit)', async () => {
        const { octokit, calls } = fakeOctokit();
        const result = await executeFinalizeRelease(
            {
                repoOwner: 'acme',
                repoName: 'widget',
                mergeSha: 'merge-sha-deadbeef',
                prNumber: 42,
                prBody: 'A human-edited PR body with no marker.',
                headRef: 'release/v1.5.0',
            },
            { octokit, workspaceRoot: '/tmp' },
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('plan marker');
        // Nothing was created.
        expect(calls.createRef).not.toHaveBeenCalled();
        expect(calls.createRelease).not.toHaveBeenCalled();
    });
});

describe('executeProposeRelease — failure path', () => {
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
        const git = fakeGit();
        // Force a PR-creation failure (e.g. "Allow Actions to create PRs" toggle off).
        calls.createPR.mockRejectedValueOnce(
            new Error('GitHub Actions is not permitted to create or approve pull requests.'),
        );
        const result = await executeProposeRelease(makePlan(), {
            octokit,
            workspaceRoot: dir,
            git: git as unknown as Parameters<typeof executeProposeRelease>[1]['git'],
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('not permitted');
        expect(calls.createComment).toHaveBeenCalled();
        const body = calls.createComment.mock.calls[0]?.[0] as { body: string };
        expect(body.body).toContain('failed to release');
    });
});
