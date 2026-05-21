import { describe, it, expect, vi } from 'vitest';
import {
    reconcileReleaseBranch,
    OpenReleasePRConflictError,
    type ReconcileOctokit,
} from '../../src/steps/reconcile-release-branch.js';
import { makePlan } from '../fixtures/plan.js';

function statusError(status: number, msg = 'http error'): Error {
    const err = new Error(msg) as Error & { status?: number };
    err.status = status;
    return err;
}

function makeOctokit(overrides: {
    getBranch?: ReconcileOctokit['rest']['repos']['getBranch'];
    pullsList?: ReconcileOctokit['rest']['pulls']['list'];
    deleteRef?: ReconcileOctokit['rest']['git']['deleteRef'];
} = {}): ReconcileOctokit {
    return {
        rest: {
            repos: {
                getBranch:
                    overrides.getBranch ??
                    vi.fn(async () => {
                        throw statusError(404);
                    }),
            },
            pulls: {
                list: overrides.pullsList ?? vi.fn(async () => ({ data: [] })),
            },
            git: {
                deleteRef: overrides.deleteRef ?? vi.fn(async () => ({})),
            },
        },
    };
}

describe('reconcileReleaseBranch', () => {
    it('returns { branchAbsent: true } when the remote branch does not exist (404)', async () => {
        const octokit = makeOctokit();
        const result = await reconcileReleaseBranch(makePlan(), octokit);

        expect(result.branchAbsent).toBe(true);
        expect(result.orphanReclaimed).toBe(false);
        expect(result.branch).toBe('release/v1.5.0');
        // No PR lookup, no delete — fresh path is the cheapest one.
        expect(octokit.rest.pulls.list).not.toHaveBeenCalled();
        expect(octokit.rest.git.deleteRef).not.toHaveBeenCalled();
    });

    it('deletes the remote ref and returns { orphanReclaimed: true } when branch exists with no open PR', async () => {
        const deleteRef = vi.fn(async () => ({}));
        const octokit = makeOctokit({
            getBranch: vi.fn(async () => ({ data: { name: 'release/v1.5.0' } })),
            pullsList: vi.fn(async () => ({ data: [] })),
            deleteRef,
        });

        const result = await reconcileReleaseBranch(makePlan(), octokit);

        expect(result.branchAbsent).toBe(false);
        expect(result.orphanReclaimed).toBe(true);
        expect(deleteRef).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'widget',
            ref: 'heads/release/v1.5.0',
        });
    });

    it('throws OpenReleasePRConflictError when an in-flight release PR exists on the branch', async () => {
        const deleteRef = vi.fn(async () => ({}));
        const octokit = makeOctokit({
            getBranch: vi.fn(async () => ({ data: { name: 'release/v1.5.0' } })),
            pullsList: vi.fn(async () => ({
                data: [
                    {
                        number: 42,
                        state: 'open',
                        html_url: 'https://github.com/acme/widget/pull/42',
                    },
                ],
            })),
            deleteRef,
        });

        await expect(reconcileReleaseBranch(makePlan(), octokit)).rejects.toThrow(
            OpenReleasePRConflictError,
        );

        // Never delete a branch when a PR is in flight — that would silently
        // close the PR. Hard fail with a clear message is the contract.
        expect(deleteRef).not.toHaveBeenCalled();
    });

    it('the conflict error carries the PR number, URL, and branch for the bot to render', async () => {
        const octokit = makeOctokit({
            getBranch: vi.fn(async () => ({ data: { name: 'release/v1.5.0' } })),
            pullsList: vi.fn(async () => ({
                data: [
                    {
                        number: 99,
                        state: 'open',
                        html_url: 'https://github.com/acme/widget/pull/99',
                    },
                ],
            })),
        });

        try {
            await reconcileReleaseBranch(makePlan(), octokit);
            expect.fail('expected OpenReleasePRConflictError');
        } catch (err) {
            expect(err).toBeInstanceOf(OpenReleasePRConflictError);
            const cast = err as OpenReleasePRConflictError;
            expect(cast.prNumber).toBe(99);
            expect(cast.prUrl).toBe('https://github.com/acme/widget/pull/99');
            expect(cast.branch).toBe('release/v1.5.0');
            expect(cast.message).toContain('#99');
            expect(cast.message).toContain('release/v1.5.0');
        }
    });

    it('scopes the PR search to owner:branch so substring matches do not leak in', async () => {
        // Explicit param typing so TS infers the `.mock.calls[0]?.[0]`
        // accessor as the input shape, not as `never` from an empty-tuple
        // parameter inference.
        const pullsList: ReconcileOctokit['rest']['pulls']['list'] = vi.fn(async () => ({
            data: [],
        }));
        const octokit = makeOctokit({
            getBranch: vi.fn(async () => ({ data: { name: 'release/v1.5.0' } })),
            pullsList,
        });

        await reconcileReleaseBranch(makePlan(), octokit);

        const mockCalls = (pullsList as unknown as { mock: { calls: Array<[unknown]> } }).mock
            .calls;
        const args = mockCalls[0]?.[0] as { head?: string; state?: string } | undefined;
        expect(args?.head).toBe('acme:release/v1.5.0');
        expect(args?.state).toBe('open');
    });

    it('propagates non-404 errors from getBranch (e.g. 403/5xx)', async () => {
        const octokit = makeOctokit({
            getBranch: vi.fn(async () => {
                throw statusError(500, 'internal error');
            }),
        });

        await expect(reconcileReleaseBranch(makePlan(), octokit)).rejects.toThrow(
            'internal error',
        );
    });

    it('uses the per-package monorepo event tag for the branch name', async () => {
        const octokit = makeOctokit();
        const monorepoPlan = makePlan({ nextVersion: 'event-2026-05-21' });

        const result = await reconcileReleaseBranch(monorepoPlan, octokit);

        expect(result.branch).toBe('release/vevent-2026-05-21');
    });
});
