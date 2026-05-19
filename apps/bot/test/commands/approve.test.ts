import { describe, it, expect, vi } from 'vitest';
import {
    dispatchReleaseWorkflow,
    parseApproveCommand,
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
