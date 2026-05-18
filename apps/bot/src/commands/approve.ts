import type {
    BumpType,
    ReleasePlan,
    RepoConfig,
    VersioningScheme,
} from '@tagline-sh/shared';
import { RELEASE_WORKFLOW_FILE } from '@tagline-sh/shared';
import {
    calculateNextVersion,
    deterministicReport,
    OctokitGitHubReader,
    readRepoConfig,
    type ReaderOctokit,
} from '../services/index.js';
import { buildReleaseReport } from './release-report.js';

export interface ApproveCommand {
    bumpOverride: BumpType | null;
    /** Explicit version string from `/approve as X.Y.Z`. Mutually exclusive with bumpOverride. */
    versionOverride: string | null;
    isDraft: boolean;
    isDryRun: boolean;
    branchOverride: string | null;
}

const VALID_BUMPS: ReadonlySet<BumpType> = new Set(['major', 'minor', 'patch']);

/**
 * Parse the `/approve` command line per PLAN.md §9, extended for calver /
 * incremental schemes.
 *
 * Examples:
 *   /approve                       → { bumpOverride: null, ... }
 *   /approve minor                 → { bumpOverride: 'minor', ... }   (semver only)
 *   /approve as 2026.6.0           → { versionOverride: '2026.6.0', ... }
 *   /approve --draft               → { isDraft: true }
 *   /approve major --dry-run       → { bumpOverride: 'major', isDryRun: true }
 *   /approve as 2026.6.0 --draft   → version override + draft flag
 *
 * Returns `null` for an unparseable command (e.g. `/approve foo`, or
 * `bumpOverride + versionOverride` together). Callers should treat that as a
 * user error and surface a usage message.
 */
export function parseApproveCommand(args: string): ApproveCommand | null {
    const tokens = args.trim().split(/\s+/).filter(Boolean);

    let bumpOverride: BumpType | null = null;
    let versionOverride: string | null = null;
    let isDraft = false;
    let isDryRun = false;
    let branchOverride: string | null = null;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t === '--draft') {
            isDraft = true;
            continue;
        }
        if (t === '--dry-run') {
            isDryRun = true;
            continue;
        }
        if (t === '--branch') {
            const next = tokens[i + 1];
            if (!next) return null;
            branchOverride = next;
            i += 1;
            continue;
        }
        if (t === 'as') {
            const next = tokens[i + 1];
            if (!next) return null;
            if (versionOverride) return null;
            versionOverride = next;
            i += 1;
            continue;
        }
        if (VALID_BUMPS.has(t as BumpType)) {
            if (bumpOverride) return null; // multiple bumps specified
            bumpOverride = t as BumpType;
            continue;
        }
        // Unknown token — reject so the user sees a usage message instead of a
        // silent misinterpretation.
        return null;
    }

    if (bumpOverride && versionOverride) return null;

    return { bumpOverride, versionOverride, isDraft, isDryRun, branchOverride };
}

export interface BuildApprovePlanInput {
    octokit: ReaderOctokit;
    owner: string;
    repo: string;
    command: ApproveCommand;
    /** GitHub user who issued the slash command. */
    approvedBy: string;
    /** Issue number where the comment was posted. */
    issueNumber: number;
    /** Optional AI config — purely for the report-comment reasoning. */
    ai?: { apiKey: string; baseUrl?: string; model?: string };
}

export type BuildApprovePlanResult =
    | { ok: true; plan: ReleasePlan; empty: boolean }
    /** User-visible validation error (e.g. bump words on a calver repo). */
    | { ok: false; error: string };

/**
 * Build the final `ReleasePlan` to send to the action.
 *
 * Key design choice: the changelog written to disk is always the deterministic
 * version (PRs → Keep-a-Changelog), NOT the AI-generated preview. This keeps
 * the on-disk artifact reproducible and verifiable; the AI is only used for
 * the report-comment reasoning that humans review pre-approval.
 *
 * Validation lives here (rather than in `parseApproveCommand`) because it
 * depends on the repo's `.release-agent.md` — for example, `/approve minor`
 * is valid only when `versioning.scheme === 'semver'`.
 */
export async function buildApprovePlan(
    input: BuildApprovePlanInput,
): Promise<BuildApprovePlanResult> {
    const reportInput: Parameters<typeof buildReleaseReport>[0] = {
        octokit: input.octokit,
        owner: input.owner,
        repo: input.repo,
    };
    if (input.command.branchOverride) reportInput.branch = input.command.branchOverride;
    if (input.ai) reportInput.ai = input.ai;

    const config = await readConfigForCalc(input);
    const scheme = config.versioning.scheme;

    if (scheme !== 'semver' && input.command.bumpOverride) {
        return {
            ok: false,
            error:
                `Bump words like \`${input.command.bumpOverride}\` only apply when ` +
                '`versioning.scheme` is `semver`. This repo is configured for ' +
                `\`${scheme}\`. Use \`/approve\` (auto-computed) or \`/approve as <version>\` to override.`,
        };
    }

    const { report } = await buildReleaseReport(reportInput);

    if (report.prs.length === 0) {
        return {
            ok: true,
            plan: emptyPlan(input, report.baseBranch, report.currentVersion),
            empty: true,
        };
    }

    const finalBump: BumpType = input.command.bumpOverride ?? report.suggestedBump;
    const finalVersion = input.command.versionOverride
        ? input.command.versionOverride
        : computeFinalVersion(scheme, finalBump, report, config);

    // Always regenerate the on-disk changelog deterministically.
    const det = deterministicReport({
        prs: report.prs,
        suggestedBump: finalBump,
        suggestedVersion: finalVersion,
        config,
    });

    const plan: ReleasePlan = {
        repoOwner: input.owner,
        repoName: input.repo,
        baseBranch: report.baseBranch,
        bumpType: finalBump,
        currentVersion: report.currentVersion,
        nextVersion: finalVersion,
        lastTag: report.lastTag,
        prs: report.prs,
        changelogContent: det.changelogPreview,
        isMonorepo: report.isMonorepo,
        monorepoInfo: report.monorepoInfo,
        isDraft: input.command.isDraft,
        isDryRun: input.command.isDryRun,
        issueNumber: input.issueNumber,
        approvedBy: input.approvedBy,
        approvedAt: new Date().toISOString(),
    };

    return { ok: true, plan, empty: false };
}

/**
 * Resolve the final version string for the release.
 *
 * SemVer's `bump === 'none'` short-circuits to the current version (no change).
 * CalVer/Incremental always advance — their next version is determined by the
 * scheme regardless of conventional-commit bumps.
 */
function computeFinalVersion(
    scheme: VersioningScheme,
    finalBump: BumpType,
    report: { currentVersion: string; baseBranch: string },
    config: RepoConfig,
): string {
    if (scheme === 'semver' && finalBump === 'none') return report.currentVersion;
    return calculateNextVersion(report.currentVersion, finalBump, report.baseBranch, config);
}

function emptyPlan(
    input: BuildApprovePlanInput,
    baseBranch: string,
    currentVersion: string,
): ReleasePlan {
    return {
        repoOwner: input.owner,
        repoName: input.repo,
        baseBranch,
        bumpType: 'none',
        currentVersion,
        nextVersion: currentVersion,
        lastTag: null,
        prs: [],
        changelogContent: '',
        isMonorepo: false,
        monorepoInfo: null,
        isDraft: input.command.isDraft,
        isDryRun: input.command.isDryRun,
        issueNumber: input.issueNumber,
        approvedBy: input.approvedBy,
        approvedAt: new Date().toISOString(),
    };
}

// Local helper that re-fetches the config. Caching is left to the caller's
// Octokit transport layer; the bot is intentionally stateless.
async function readConfigForCalc(input: BuildApprovePlanInput): Promise<RepoConfig> {
    const reader = new OctokitGitHubReader(input.octokit);
    return readRepoConfig(reader, { owner: input.owner, repo: input.repo });
}

// --- Workflow dispatch -------------------------------------------------------

export interface DispatchOctokit {
    rest: {
        repos: {
            getContent: (params: {
                owner: string;
                repo: string;
                path: string;
            }) => Promise<unknown>;
        };
        actions: {
            createWorkflowDispatch: (params: {
                owner: string;
                repo: string;
                workflow_id: string;
                ref: string;
                inputs?: Record<string, string>;
            }) => Promise<unknown>;
        };
    };
}

export interface DispatchResult {
    /** True if the workflow file exists and dispatch was accepted. */
    dispatched: boolean;
    /** Set when the workflow file is missing in the user's repo. */
    missingWorkflow: boolean;
    /** Set when dispatch itself errored. */
    error?: string;
}

/**
 * Dispatch the user's `release-agent.yml` workflow with the encoded plan.
 *
 * Pre-flight: confirm the workflow file exists. The "missing workflow" case is
 * extremely common for first-time installs, and a setup-instructions comment
 * is far more useful than a generic "could not dispatch" failure.
 */
export async function dispatchReleaseWorkflow(
    octokit: DispatchOctokit,
    owner: string,
    repo: string,
    plan: ReleasePlan,
): Promise<DispatchResult> {
    try {
        await octokit.rest.repos.getContent({
            owner,
            repo,
            path: `.github/workflows/${RELEASE_WORKFLOW_FILE}`,
        });
    } catch (err) {
        if (isStatus(err, 404)) return { dispatched: false, missingWorkflow: true };
        return {
            dispatched: false,
            missingWorkflow: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }

    try {
        await octokit.rest.actions.createWorkflowDispatch({
            owner,
            repo,
            workflow_id: RELEASE_WORKFLOW_FILE,
            ref: plan.baseBranch,
            inputs: {
                release_plan: JSON.stringify(plan),
                issue_number: String(plan.issueNumber),
                dry_run: plan.isDryRun ? 'true' : 'false',
            },
        });
        return { dispatched: true, missingWorkflow: false };
    } catch (err) {
        return {
            dispatched: false,
            missingWorkflow: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

function isStatus(err: unknown, status: number): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === status
    );
}
