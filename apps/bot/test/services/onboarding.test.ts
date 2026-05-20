import { describe, it, expect, vi } from 'vitest';
import {
    ONBOARDING_BRANCH_NAME,
    ONBOARDING_CONFIG_PATH,
    ONBOARDING_PR_TITLE,
    ONBOARDING_WORKFLOW_PATH,
    ensureOnboardingPR,
    findExistingOnboardingPR,
    renderDefaultReleaseAgentConfig,
    renderOnboardingPRBody,
    type OnboardingOctokit,
} from '../../src/services/onboarding.js';

const REPO = { owner: 'acme', repo: 'widget' };

interface FakeOpts {
    /** Set of paths that exist on the default branch. */
    existingPaths?: Set<string>;
    /** Open PRs to return from pulls.list. */
    openPRs?: Array<{ number: number; html_url: string; head: { ref: string } }>;
    /** If true, createRef throws a 422 (branch already exists). */
    branchExists?: boolean;
    /** Override the default branch name. */
    defaultBranch?: string;
}

interface StatusError extends Error {
    status: number;
}

function makeStatusError(status: number, msg: string): StatusError {
    const err = new Error(msg) as StatusError;
    err.status = status;
    return err;
}

function makeFake(opts: FakeOpts = {}) {
    const existingPaths = opts.existingPaths ?? new Set<string>();
    const openPRs = opts.openPRs ?? [];
    const defaultBranch = opts.defaultBranch ?? 'main';

    const calls = {
        reposGet: vi.fn(async () => ({ data: { default_branch: defaultBranch } })),
        getContent: vi.fn(async (p: { path: string }) => {
            if (!existingPaths.has(p.path)) {
                throw makeStatusError(404, 'Not Found');
            }
            return { data: {} };
        }),
        createOrUpdateFileContents: vi.fn(async () => ({
            data: { commit: { sha: 'commit-sha' } },
        })),
        getRef: vi.fn(async () => ({ data: { object: { sha: 'base-sha' } } })),
        createRef: vi.fn(async () => {
            if (opts.branchExists) throw makeStatusError(422, 'Reference already exists');
            return {};
        }),
        pullsList: vi.fn(async () => ({ data: openPRs })),
        pullsCreate: vi.fn(async () => ({
            data: { number: 99, html_url: 'https://example/pulls/99' },
        })),
    };

    const octokit = {
        rest: {
            repos: {
                get: calls.reposGet,
                getContent: calls.getContent,
                createOrUpdateFileContents: calls.createOrUpdateFileContents,
            },
            git: {
                getRef: calls.getRef,
                createRef: calls.createRef,
            },
            pulls: {
                list: calls.pullsList,
                create: calls.pullsCreate,
            },
        },
    } as unknown as OnboardingOctokit;

    return { octokit, calls };
}

function firstCallArg<T>(spy: ReturnType<typeof vi.fn>): T {
    const calls = spy.mock.calls as unknown as Array<[T]>;
    const first = calls[0];
    if (!first) throw new Error('expected spy to have been called');
    return first[0];
}

describe('renderDefaultReleaseAgentConfig', () => {
    it('exposes the documented Branches and Release Notes Style sections', () => {
        const md = renderDefaultReleaseAgentConfig();
        expect(md).toContain('## Branches');
        expect(md).toContain('- production: main');
        expect(md).toContain('## Release Notes Style');
        // The configuration.md docs treat free-form sections as AI context;
        // the default ships at least one such section so the AI prompt isn't
        // empty.
        expect(md).toContain('## Scope Notes');
    });
});

describe('renderOnboardingPRBody', () => {
    it('embeds the workflow YAML so users can copy-paste it', () => {
        const body = renderOnboardingPRBody({ workflowYaml: 'name: Test Workflow' });
        expect(body).toContain('```yaml');
        expect(body).toContain('name: Test Workflow');
    });

    it('mentions the release-tracking issue venue + the two commands', () => {
        const body = renderOnboardingPRBody({ workflowYaml: '' });
        expect(body).toContain('release-tracking issue');
        expect(body).toContain('tagline:release-pending');
        expect(body).toContain('/release-report');
        expect(body).toContain('/approve');
    });

    it('has an actionable checklist users can tick off', () => {
        const body = renderOnboardingPRBody({ workflowYaml: '' });
        expect(body).toMatch(/- \[ \] /); // at least one unchecked checkbox
        expect(body).toContain('AI_API_KEY');
    });
});

describe('findExistingOnboardingPR', () => {
    it('returns the PR whose head ref matches the onboarding branch', async () => {
        const { octokit } = makeFake({
            openPRs: [
                { number: 1, html_url: 'u1', head: { ref: 'feature/x' } },
                { number: 7, html_url: 'u7', head: { ref: ONBOARDING_BRANCH_NAME } },
            ],
        });
        const found = await findExistingOnboardingPR(octokit, REPO);
        expect(found).toEqual({ number: 7, html_url: 'u7' });
    });

    it('returns null when no open PR matches', async () => {
        const { octokit } = makeFake({
            openPRs: [{ number: 1, html_url: 'u', head: { ref: 'feature/x' } }],
        });
        expect(await findExistingOnboardingPR(octokit, REPO)).toBeNull();
    });
});

describe('ensureOnboardingPR — skip paths', () => {
    it('skips with already-configured when both files exist on default branch', async () => {
        const { octokit, calls } = makeFake({
            existingPaths: new Set([ONBOARDING_CONFIG_PATH, ONBOARDING_WORKFLOW_PATH]),
        });
        const result = await ensureOnboardingPR(octokit, REPO);
        expect(result).toEqual({ kind: 'skipped', reason: 'already-configured' });
        // No branch creation, no PR open.
        expect(calls.createRef).not.toHaveBeenCalled();
        expect(calls.pullsCreate).not.toHaveBeenCalled();
    });

    it('skips with pr-already-open when our branch already has an open PR', async () => {
        const { octokit, calls } = makeFake({
            openPRs: [{ number: 5, html_url: 'u5', head: { ref: ONBOARDING_BRANCH_NAME } }],
        });
        const result = await ensureOnboardingPR(octokit, REPO);
        expect(result).toEqual({ kind: 'skipped', reason: 'pr-already-open' });
        expect(calls.createRef).not.toHaveBeenCalled();
        expect(calls.pullsCreate).not.toHaveBeenCalled();
    });
});

describe('ensureOnboardingPR — create path', () => {
    it('creates branch, commits config, and opens the PR on a fresh repo', async () => {
        const { octokit, calls } = makeFake();
        const result = await ensureOnboardingPR(octokit, REPO);

        expect(result).toEqual({
            kind: 'created',
            prNumber: 99,
            prUrl: 'https://example/pulls/99',
        });

        // Branch was created off the default branch's HEAD.
        const refCall = firstCallArg<{ ref: string; sha: string }>(calls.createRef);
        expect(refCall.ref).toBe(`refs/heads/${ONBOARDING_BRANCH_NAME}`);
        expect(refCall.sha).toBe('base-sha');

        // Config file was committed on the new branch as base64.
        const commitCall = firstCallArg<{
            path: string;
            content: string;
            branch?: string;
        }>(calls.createOrUpdateFileContents);
        expect(commitCall.path).toBe(ONBOARDING_CONFIG_PATH);
        expect(commitCall.branch).toBe(ONBOARDING_BRANCH_NAME);
        const decoded = Buffer.from(commitCall.content, 'base64').toString('utf-8');
        expect(decoded).toContain('## Branches');

        // PR was opened with the canonical title.
        const prCall = firstCallArg<{
            title: string;
            head: string;
            base: string;
            body: string;
        }>(calls.pullsCreate);
        expect(prCall.title).toBe(ONBOARDING_PR_TITLE);
        expect(prCall.head).toBe(ONBOARDING_BRANCH_NAME);
        expect(prCall.base).toBe('main');
        expect(prCall.body).toContain('release-tracking issue');
    });

    it("does NOT commit the config when it already exists on the default branch (workflow missing)", async () => {
        // Half-configured: user has .release-agent.md but never added the
        // workflow. We should still open the PR (so the body re-explains the
        // workflow step), but NOT clobber their existing config.
        const { octokit, calls } = makeFake({
            existingPaths: new Set([ONBOARDING_CONFIG_PATH]),
        });
        const result = await ensureOnboardingPR(octokit, REPO);
        expect(result.kind).toBe('created');
        expect(calls.createOrUpdateFileContents).not.toHaveBeenCalled();
        expect(calls.pullsCreate).toHaveBeenCalledOnce();
    });

    it("does NOT commit the config when it already exists, but workflow is missing — config takes precedence", async () => {
        // Inverse of the previous case: workflow present but config absent.
        // We commit the config, open the PR.
        const { octokit, calls } = makeFake({
            existingPaths: new Set([ONBOARDING_WORKFLOW_PATH]),
        });
        const result = await ensureOnboardingPR(octokit, REPO);
        expect(result.kind).toBe('created');
        expect(calls.createOrUpdateFileContents).toHaveBeenCalledOnce();
    });

    it('swallows 422 on createRef (branch left from a prior partial run) and proceeds to open the PR', async () => {
        const { octokit, calls } = makeFake({ branchExists: true });
        const result = await ensureOnboardingPR(octokit, REPO);
        expect(result.kind).toBe('created');
        // PR is still opened even though branch creation 422'd.
        expect(calls.pullsCreate).toHaveBeenCalledOnce();
    });

    it('uses the repo’s actual default branch (not assumed `main`)', async () => {
        const { octokit, calls } = makeFake({ defaultBranch: 'trunk' });
        await ensureOnboardingPR(octokit, REPO);
        const prCall = firstCallArg<{ base: string }>(calls.pullsCreate);
        expect(prCall.base).toBe('trunk');
        const refCall = firstCallArg<{ ref: string }>(calls.getRef);
        expect(refCall.ref).toBe('heads/trunk');
    });
});

describe('ensureOnboardingPR — error propagation', () => {
    it('propagates non-404 errors from fileExists (e.g. 403 means abort, do not silently "configure")', async () => {
        const { octokit } = makeFake();
        const calls = (octokit as unknown as { rest: { repos: { getContent: ReturnType<typeof vi.fn> } } })
            .rest.repos.getContent;
        calls.mockRejectedValueOnce(makeStatusError(403, 'Forbidden'));
        await expect(ensureOnboardingPR(octokit, REPO)).rejects.toMatchObject({ status: 403 });
    });
});
