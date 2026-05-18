import type { BumpType, ReleasePlan, RepoConfig } from '@tagline-sh/shared';
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
    isDraft: boolean;
    isDryRun: boolean;
    branchOverride: string | null;
}

const VALID_BUMPS: ReadonlySet<BumpType> = new Set(['major', 'minor', 'patch']);

/**
 * Parse the `/approve` command line per PLAN.md §9.
 *
 * Examples:
 *   /approve                  → { bumpOverride: null, ... }
 *   /approve minor            → { bumpOverride: 'minor', ... }
 *   /approve --draft          → { isDraft: true }
 *   /approve major --dry-run  → { bumpOverride: 'major', isDryRun: true }
 *
 * Returns `null` for an unparseable command (e.g. `/approve foo`). Callers
 * should treat that as a user error and surface a usage message.
 */
export function parseApproveCommand(args: string): ApproveCommand | null {
    const tokens = args.trim().split(/\s+/).filter(Boolean);

    let bumpOverride: BumpType | null = null;
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
        if (VALID_BUMPS.has(t as BumpType)) {
            if (bumpOverride) return null; // multiple bumps specified
            bumpOverride = t as BumpType;
            continue;
        }
        // Unknown token — reject so the user sees a usage message instead of a
        // silent misinterpretation.
        return null;
    }

    return { bumpOverride, isDraft, isDryRun, branchOverride };
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

export interface BuildApprovePlanResult {
    plan: ReleasePlan;
    /** True if no PRs found — caller should bail with "no changes" message. */
    empty: boolean;
}

/**
 * Build the final `ReleasePlan` to send to the action.
 *
 * Key design choice: the changelog written to disk is always the deterministic
 * version (PRs → Keep-a-Changelog), NOT the AI-generated preview. This keeps
 * the on-disk artifact reproducible and verifiable; the AI is only used for
 * the report-comment reasoning that humans review pre-approval.
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

    const { report } = await buildReleaseReport(reportInput);

    if (report.prs.length === 0) {
        return {
            plan: emptyPlan(input, report.baseBranch, report.currentVersion),
            empty: true,
        };
    }

    const finalBump: BumpType = input.command.bumpOverride ?? report.suggestedBump;
    const finalVersion =
        finalBump === 'none'
            ? report.currentVersion
            : calculateNextVersion(
                  report.currentVersion,
                  finalBump,
                  report.baseBranch,
                  await readConfigForCalc(input, report.baseBranch),
              );

    // Always regenerate the on-disk changelog deterministically.
    const det = deterministicReport({
        prs: report.prs,
        suggestedBump: finalBump,
        suggestedVersion: finalVersion,
        config: await readConfigForCalc(input, report.baseBranch),
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

    return { plan, empty: false };
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
async function readConfigForCalc(
    input: BuildApprovePlanInput,
    _branch: string,
): Promise<RepoConfig> {
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
