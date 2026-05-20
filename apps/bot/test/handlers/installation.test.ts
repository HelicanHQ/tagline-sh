import { describe, it, expect, vi } from 'vitest';
import { onboardRepositories } from '../../src/handlers/installation.js';
import type {
    EnsureOnboardingResult,
    OnboardingOctokit,
} from '../../src/services/onboarding.js';

/**
 * Most of the onboarding logic lives in `services/onboarding.ts` and is
 * covered by `onboarding.test.ts`. These handler tests focus on the
 * cross-repo loop semantics: per-repo error isolation and outcome shapes.
 */

interface FakeOpts {
    /** Per-repo results, keyed by repo name. */
    results?: Record<string, EnsureOnboardingResult>;
    /** Per-repo errors, keyed by repo name. Overrides results. */
    errors?: Record<string, Error>;
}

function makeFake(opts: FakeOpts = {}) {
    // We don't need a real Octokit here — we shim `ensureOnboardingPR` via a
    // proxy that maps from the second arg (RepoRef) to a configured result.
    // The handler under test is the *loop*, not the per-repo orchestrator.
    const calls: string[] = [];

    // Track which repos were "called" by stubbing repos.get — its presence
    // and call order is enough because we then short-circuit via the mocked
    // ensureOnboardingPR module below.
    const reposGet = vi.fn(async (p: { repo: string }) => {
        calls.push(p.repo);
        const err = opts.errors?.[p.repo];
        if (err) throw err;
        return { data: { default_branch: 'main' } };
    });

    // Minimal getContent that says "everything exists" so the orchestrator
    // skips with 'already-configured' — unless we override via results.
    const getContent = vi.fn(async () => ({ data: {} }));

    const octokit = {
        rest: {
            repos: { get: reposGet, getContent, createOrUpdateFileContents: vi.fn() },
            git: { getRef: vi.fn(), createRef: vi.fn() },
            pulls: { list: vi.fn(async () => ({ data: [] })), create: vi.fn() },
        },
    } as unknown as OnboardingOctokit;

    return { octokit, calls };
}

describe('onboardRepositories — per-repo isolation', () => {
    it('processes all repos when one throws (error captured, others continue)', async () => {
        const { octokit, calls } = makeFake({
            errors: { 'broken': new Error('boom') },
        });

        const outcomes = await onboardRepositories(octokit, [
            { owner: 'acme', repo: 'first' },
            { owner: 'acme', repo: 'broken' },
            { owner: 'acme', repo: 'third' },
        ]);

        expect(calls).toEqual(['first', 'broken', 'third']);
        expect(outcomes).toHaveLength(3);

        const firstOutcome = outcomes[0]!;
        const brokenOutcome = outcomes[1]!;
        const thirdOutcome = outcomes[2]!;

        // first + third succeeded all the way to the "already-configured"
        // short-circuit (getContent returns ok for both files).
        expect('result' in firstOutcome ? firstOutcome.result.kind : null).toBe('skipped');
        expect('result' in thirdOutcome ? thirdOutcome.result.kind : null).toBe('skipped');
        // broken caught the thrown error.
        expect('error' in brokenOutcome ? (brokenOutcome.error as Error).message : null).toBe(
            'boom',
        );
    });

    it('returns an empty outcomes array when called with no repos', async () => {
        const { octokit } = makeFake();
        const outcomes = await onboardRepositories(octokit, []);
        expect(outcomes).toEqual([]);
    });

    it('attaches the originating repo ref to each outcome', async () => {
        const { octokit } = makeFake();
        const outcomes = await onboardRepositories(octokit, [
            { owner: 'acme', repo: 'one' },
            { owner: 'acme', repo: 'two' },
        ]);
        expect(outcomes.map((o) => o.repo.repo)).toEqual(['one', 'two']);
    });
});
