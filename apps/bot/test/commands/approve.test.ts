import { describe, it, expect, vi } from 'vitest';
import type { ParsedPR, PackageReleasePlan } from '@tagline-sh/shared';
import { ReleasePlanSchema } from '@tagline-sh/shared';
import {
    dispatchReleaseWorkflow,
    parseApproveCommand,
    slimPlanForDispatch,
    type DispatchOctokit,
} from '../../src/commands/approve.js';
import { makePlan } from './fixtures.js';

describe('parseApproveCommand', () => {
    it('parses bare /approve', () => {
        expect(parseApproveCommand('')).toEqual({
            bumpOverride: null,
            versionOverride: null,
            packageBumpOverrides: new Map(),
            isDraft: false,
            isDryRun: false,
            branchOverride: null,
        });
    });

    it.each(['patch', 'minor', 'major'])('parses /approve %s', (bump) => {
        const r = parseApproveCommand(bump);
        expect(r?.bumpOverride).toBe(bump);
        expect(r?.versionOverride).toBeNull();
    });

    it('parses --draft and --dry-run flags in any order', () => {
        expect(parseApproveCommand('--draft')?.isDraft).toBe(true);
        expect(parseApproveCommand('--dry-run')?.isDryRun).toBe(true);
        const both = parseApproveCommand('major --draft --dry-run');
        expect(both).toEqual({
            bumpOverride: 'major',
            versionOverride: null,
            packageBumpOverrides: new Map(),
            isDraft: true,
            isDryRun: true,
            branchOverride: null,
        });
    });

    it('parses --branch <name>', () => {
        expect(parseApproveCommand('--branch staging')?.branchOverride).toBe('staging');
    });

    it('parses `as <version>` override', () => {
        expect(parseApproveCommand('as 2026.6.0')).toEqual({
            bumpOverride: null,
            versionOverride: '2026.6.0',
            packageBumpOverrides: new Map(),
            isDraft: false,
            isDryRun: false,
            branchOverride: null,
        });
    });

    it('combines `as <version>` with flags', () => {
        const r = parseApproveCommand('as 2026.6.0 --draft --dry-run');
        expect(r?.versionOverride).toBe('2026.6.0');
        expect(r?.isDraft).toBe(true);
        expect(r?.isDryRun).toBe(true);
    });

    it('rejects `as` with no argument', () => {
        expect(parseApproveCommand('as')).toBeNull();
    });

    it('rejects bump + `as` mixed', () => {
        expect(parseApproveCommand('minor as 2026.6.0')).toBeNull();
    });

    it('rejects multiple bump tokens', () => {
        expect(parseApproveCommand('minor major')).toBeNull();
    });

    it('rejects unknown tokens', () => {
        expect(parseApproveCommand('--what')).toBeNull();
        expect(parseApproveCommand('foo')).toBeNull();
    });

    it('parses per-package overrides `name:bump` (M3.4)', () => {
        const r = parseApproveCommand('api:minor ui:patch');
        expect(r?.packageBumpOverrides).toEqual(
            new Map([
                ['api', 'minor'],
                ['ui', 'patch'],
            ]),
        );
        // Other fields stay default.
        expect(r?.bumpOverride).toBeNull();
        expect(r?.versionOverride).toBeNull();
    });

    it('accepts scoped package names in overrides', () => {
        const r = parseApproveCommand('@acme/api:minor');
        expect(r?.packageBumpOverrides.get('@acme/api')).toBe('minor');
    });

    it('combines per-package overrides with --draft / --dry-run', () => {
        const r = parseApproveCommand('api:minor --draft --dry-run');
        expect(r?.packageBumpOverrides.get('api')).toBe('minor');
        expect(r?.isDraft).toBe(true);
        expect(r?.isDryRun).toBe(true);
    });

    it('rejects per-package overrides combined with a global bump', () => {
        expect(parseApproveCommand('minor api:patch')).toBeNull();
    });

    it('rejects per-package overrides combined with `as <version>`', () => {
        expect(parseApproveCommand('as 1.2.3 api:patch')).toBeNull();
    });

    it('rejects duplicate package names in overrides', () => {
        expect(parseApproveCommand('api:minor api:patch')).toBeNull();
    });

    it('rejects an unknown bump in the package-override pair', () => {
        // `api:megamajor` — the bump half doesn't match. Unknown token path.
        expect(parseApproveCommand('api:megamajor')).toBeNull();
    });

    it('rejects --branch with no argument', () => {
        expect(parseApproveCommand('--branch')).toBeNull();
    });
});

describe('dispatchReleaseWorkflow', () => {
    function build({
        getContentImpl,
        dispatchImpl,
    }: {
        getContentImpl: () => Promise<unknown>;
        dispatchImpl?: () => Promise<unknown>;
    }): { octokit: DispatchOctokit; calls: ReturnType<typeof vi.fn>[] } {
        const calls: ReturnType<typeof vi.fn>[] = [];
        const getContent = vi.fn(getContentImpl);
        const createWorkflowDispatch = vi.fn(dispatchImpl ?? (async () => ({})));
        calls.push(getContent, createWorkflowDispatch);
        return {
            octokit: {
                rest: {
                    repos: { getContent },
                    actions: { createWorkflowDispatch },
                },
            },
            calls,
        };
    }

    it('reports missingWorkflow on 404 from getContent', async () => {
        const { octokit } = build({
            getContentImpl: async () => {
                const err = new Error('404') as Error & { status: number };
                err.status = 404;
                throw err;
            },
        });
        const r = await dispatchReleaseWorkflow(octokit, 'acme', 'widget', makePlan());
        expect(r.missingWorkflow).toBe(true);
        expect(r.dispatched).toBe(false);
    });

    it('dispatches with the encoded plan when the workflow exists', async () => {
        const { octokit, calls } = build({
            getContentImpl: async () => ({ data: { type: 'file' } }),
        });
        const plan = makePlan();
        const r = await dispatchReleaseWorkflow(octokit, 'acme', 'widget', plan);
        expect(r.dispatched).toBe(true);

        const dispatchCall = calls[1]!.mock.calls[0]?.[0] as {
            workflow_id: string;
            ref: string;
            inputs: Record<string, string>;
        };
        expect(dispatchCall.workflow_id).toBe('release-agent.yml');
        expect(dispatchCall.ref).toBe(plan.baseBranch);
        expect(dispatchCall.inputs['dry_run']).toBe('false');
        const decoded = JSON.parse(dispatchCall.inputs['release_plan']!) as { nextVersion: string };
        expect(decoded.nextVersion).toBe(plan.nextVersion);
    });

    it('pre-checks the workflow on the dispatched ref (baseBranch), not the default branch', async () => {
        // Regression: dispatching to a channel branch (e.g. `main`) that lacks
        // the workflow must surface missingWorkflow, not GitHub's opaque
        // "no workflow_dispatch trigger". The existence check must use the same
        // ref the dispatch targets.
        const { octokit, calls } = build({
            getContentImpl: async () => ({ data: { type: 'file' } }),
        });
        const plan = { ...makePlan(), baseBranch: 'main' };
        await dispatchReleaseWorkflow(octokit, 'acme', 'widget', plan);
        const getContentCall = calls[0]!.mock.calls[0]?.[0] as { ref?: string; path: string };
        expect(getContentCall.ref).toBe('main');
        expect(getContentCall.path).toContain('release-agent.yml');
    });

    it('captures dispatch errors without throwing', async () => {
        const { octokit } = build({
            getContentImpl: async () => ({ data: { type: 'file' } }),
            dispatchImpl: async () => {
                throw new Error('boom');
            },
        });
        const r = await dispatchReleaseWorkflow(octokit, 'acme', 'widget', makePlan());
        expect(r.dispatched).toBe(false);
        expect(r.missingWorkflow).toBe(false);
        expect(r.error).toContain('boom');
    });
});

/**
 * Regression suite for the "inputs are too large" workflow_dispatch failure
 * surfaced on monorepos with many packages × many PRs × commit bodies. The
 * fix slims out `prs`, `monorepoInfo`, and `packages[].prs` (data the action
 * never reads) before serializing the plan.
 */
describe('dispatchReleaseWorkflow — payload slimming + size guard', () => {
    function makeFatPR(n: number): ParsedPR {
        // ~1.5 KB per PR — five commits, each with a long body to simulate
        // squash-of-feature-branch shapes that contributors commonly produce.
        return {
            number: n,
            title: `feat: big PR #${n} with many commits`,
            url: `https://github.com/acme/widget/pull/${n}`,
            author: 'contributor',
            mergedAt: '2026-05-18T09:30:00Z',
            commits: Array.from({ length: 5 }).map((_, i) => ({
                type: 'feat' as const,
                scope: 'auth',
                subject: `commit ${i} for PR ${n}`,
                body: 'X'.repeat(250), // realistic-ish commit body
                isBreaking: false,
                sha: `${n}-${i}`,
            })),
            tickets: [`PROJ-${n}`],
            suggestedBump: 'minor',
            bodyExcerpt: 'Y'.repeat(400),
        };
    }

    function makeMonorepoPlan(packageCount: number, prsPerPackage: number) {
        const allPRs: ParsedPR[] = [];
        const packages: PackageReleasePlan[] = [];
        let prNumber = 1;
        for (let i = 0; i < packageCount; i += 1) {
            const pkgPRs: ParsedPR[] = [];
            for (let j = 0; j < prsPerPackage; j += 1) {
                const pr = makeFatPR(prNumber++);
                allPRs.push(pr);
                pkgPRs.push(pr);
            }
            packages.push({
                name: `@acme/pkg-${i}`,
                path: `packages/pkg-${i}`,
                packageJsonPath: `packages/pkg-${i}/package.json`,
                changelogPath: `packages/pkg-${i}/CHANGELOG.md`,
                currentVersion: '1.0.0',
                nextVersion: '1.1.0',
                bumpType: 'minor',
                prs: pkgPRs,
                changelogContent: `## [1.1.0]\n- bullet for pkg-${i}\n`,
                tagName: `@acme/pkg-${i}@1.1.0`,
            });
        }
        return makePlan({
            isMonorepo: true,
            prs: allPRs,
            packages,
            // monorepoInfo skipped — fixture default of null is fine; the
            // important bloat sources are `prs` and `packages[].prs`.
        });
    }

    it('strips prs, monorepoInfo, and packages[].prs before dispatch', () => {
        const plan = makeMonorepoPlan(3, 4);
        // Sanity: the full plan really does carry the duplicated PR data.
        expect(plan.prs.length).toBeGreaterThan(0);
        expect(plan.packages[0]!.prs.length).toBeGreaterThan(0);

        const slim = slimPlanForDispatch(plan) as {
            prs: unknown[];
            monorepoInfo: unknown;
            packages: Array<{ prs: unknown[] }>;
            nextVersion: string;
            packagesCount?: number;
        };
        expect(slim.prs).toEqual([]);
        expect(slim.monorepoInfo).toBeNull();
        for (const p of slim.packages) {
            expect(p.prs).toEqual([]);
        }
        // The fields the action actually consumes survive slimming.
        expect(slim.nextVersion).toBe(plan.nextVersion);
        expect(slim.packages.length).toBe(plan.packages.length);
    });

    it('produces a slim payload that is dramatically smaller than the full plan', () => {
        const plan = makeMonorepoPlan(5, 6); // 5 packages × 6 PRs × 5 commits w/ body
        const full = Buffer.byteLength(JSON.stringify(plan), 'utf8');
        const slim = Buffer.byteLength(JSON.stringify(slimPlanForDispatch(plan)), 'utf8');
        // Guardrail: slim should be at least 5x smaller. In practice it's
        // much more — this is the "we didn't accidentally regress the
        // slimming" canary.
        expect(slim * 5).toBeLessThan(full);
    });

    it('the action schema accepts a slimmed plan (no prs, null monorepoInfo)', () => {
        const plan = makeMonorepoPlan(2, 3);
        const wireJson = JSON.stringify(slimPlanForDispatch(plan));
        // Re-parse through the action-side zod schema. Defaulting prs/monorepoInfo
        // must let the slim shape validate identically to the full one.
        const parsed = ReleasePlanSchema.parse(JSON.parse(wireJson));
        expect(parsed.prs).toEqual([]);
        expect(parsed.monorepoInfo).toBeNull();
        for (const p of parsed.packages) {
            expect(p.prs).toEqual([]);
            expect(p.changelogContent.length).toBeGreaterThan(0);
        }
        // And the canonical fields the action consumes are still there.
        expect(parsed.nextVersion).toBe(plan.nextVersion);
        expect(parsed.changelogContent).toBe(plan.changelogContent);
        expect(parsed.releaseSummary.headline).toBe(plan.releaseSummary.headline);
    });

    it('dispatch sends the slim plan and reports payload size', async () => {
        const calls: ReturnType<typeof vi.fn>[] = [];
        const getContent = vi.fn(async () => ({ data: { type: 'file' } }));
        const createWorkflowDispatch = vi.fn(async () => ({}));
        calls.push(getContent, createWorkflowDispatch);
        const octokit: DispatchOctokit = {
            rest: {
                repos: { getContent },
                actions: { createWorkflowDispatch },
            },
        };

        const plan = makeMonorepoPlan(3, 4);
        const result = await dispatchReleaseWorkflow(octokit, 'acme', 'widget', plan);
        expect(result.dispatched).toBe(true);
        expect(result.payloadBytes).toBeGreaterThan(0);

        // vi.fn's tuple is inferred as `[]` when the impl has no params, so
        // we cast the whole calls array before indexing.
        const recordedCalls = createWorkflowDispatch.mock.calls as unknown as Array<
            [{ inputs: Record<string, string> }]
        >;
        const dispatchCall = recordedCalls[0]?.[0] as { inputs: Record<string, string> };
        const decoded = JSON.parse(dispatchCall.inputs['release_plan']!) as {
            prs: unknown[];
            monorepoInfo: unknown;
            packages: Array<{ prs: unknown[] }>;
        };
        expect(decoded.prs).toEqual([]);
        expect(decoded.monorepoInfo).toBeNull();
        for (const p of decoded.packages) {
            expect(p.prs).toEqual([]);
        }
    });

    it('refuses to dispatch when the slim plan still exceeds the size cap', async () => {
        // Build a plan whose RENDERED changelogContent alone is huge — that's
        // the one big string the slimmer can't safely drop. This proves the
        // size guard fires our typed error before GitHub rejects the call.
        const huge = 'lorem '.repeat(15_000); // ~90 KB
        const plan = makePlan({ changelogContent: huge });
        const octokit: DispatchOctokit = {
            rest: {
                repos: {
                    getContent: vi.fn(async () => ({ data: { type: 'file' } })),
                },
                actions: {
                    createWorkflowDispatch: vi.fn(async () => {
                        throw new Error('dispatch should never be called when over the cap');
                    }),
                },
            },
        };
        const result = await dispatchReleaseWorkflow(octokit, 'acme', 'widget', plan);
        expect(result.dispatched).toBe(false);
        expect(result.missingWorkflow).toBe(false);
        expect(result.payloadBytes).toBeGreaterThan(60_000);
        expect(result.error).toMatch(/exceeds.*workflow_dispatch input limit/i);
    });
});
