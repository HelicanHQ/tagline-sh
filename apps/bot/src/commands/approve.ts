import type {
    BumpType,
    PackageReleasePlan,
    ReleasePlan,
    ReleaseSummary,
    RepoConfig,
    VersioningScheme,
} from '@tagline-sh/shared';
import {
    buildSummaryMarkdown,
    formatSummaryDate,
    RELEASE_WORKFLOW_FILE,
    restampSummary,
} from '@tagline-sh/shared';
import {
    buildPackagePlans,
    calculateNextVersion,
    deterministicReport,
    OctokitGitHubReader,
    readRepoConfig,
    type ReaderOctokit,
} from '~/app/services';
import { buildReleaseReport } from '~/app/commands/release-report';

export interface ApproveCommand {
    bumpOverride: BumpType | null;
    /** Explicit version string from `/approve as X.Y.Z`. Mutually exclusive with bumpOverride. */
    versionOverride: string | null;
    /**
     * Per-package bump overrides (M3.4) from tokens of the form `name:bump`,
     * e.g. `api:minor` or `@acme/ui:patch`. Empty map when none supplied.
     * Only meaningful for monorepos with `versioning.scheme === 'semver'`;
     * `buildApprovePlan` rejects non-empty maps on other schemes.
     */
    packageBumpOverrides: Map<string, BumpType>;
    isDraft: boolean;
    isDryRun: boolean;
    branchOverride: string | null;
}

const VALID_BUMPS: ReadonlySet<BumpType> = new Set(['major', 'minor', 'patch']);

// Package-bump pair: `name:bump` where bump ∈ {patch,minor,major}. Name is
// permissive (npm scoped or unscoped, e.g. `@acme/api` or `api_v2`). The
// colon split happens at the FIRST colon so scoped names with no colon
// before the bump work, and any unexpected extra colons reject as an
// unknown token (safer than silently accepting).
const PKG_BUMP_RE = /^([A-Za-z0-9@][A-Za-z0-9@/_.-]*):(patch|minor|major)$/;

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
    const packageBumpOverrides = new Map<string, BumpType>();

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
        // Per-package override (M3.4): `name:bump`. Try this before the
        // generic unknown-token rejection.
        const pkgMatch = PKG_BUMP_RE.exec(t);
        if (pkgMatch) {
            const [, name, bump] = pkgMatch;
            if (!name || !bump) return null;
            if (packageBumpOverrides.has(name)) return null; // duplicate package
            packageBumpOverrides.set(name, bump as BumpType);
            continue;
        }
        // Unknown token — reject so the user sees a usage message instead of a
        // silent misinterpretation.
        return null;
    }

    if (bumpOverride && versionOverride) return null;
    // Per-package overrides combine fine with --draft / --dry-run / --branch
    // but not with the global bump override or version override (single-repo
    // concepts that conflict semantically with per-package selection).
    if (packageBumpOverrides.size > 0 && (bumpOverride || versionOverride)) {
        return null;
    }

    return {
        bumpOverride,
        versionOverride,
        packageBumpOverrides,
        isDraft,
        isDryRun,
        branchOverride,
    };
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

    if (scheme !== 'semver' && input.command.packageBumpOverrides.size > 0) {
        return {
            ok: false,
            error:
                'Per-package bump overrides like `name:minor` only apply when ' +
                '`versioning.scheme` is `semver`. This repo is configured for ' +
                `\`${scheme}\` — package versions are computed mechanically. Use ` +
                '`/approve` (auto-computed) instead.',
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

    // Monorepo branch (M3): single-repo style bump/version overrides don't
    // apply — each package has its own version. Reject them with a helpful
    // message pointing to the `<name>:<bump>` grammar instead.
    const isMonorepoRelease = report.packages.length > 0;
    if (isMonorepoRelease && input.command.bumpOverride) {
        return {
            ok: false,
            error:
                `\`/approve ${input.command.bumpOverride}\` doesn't apply in a monorepo — each package ` +
                'has its own version. Use `/approve` (auto-suggest per package) or ' +
                '`/approve <name>:<bump>` (per-package override) instead.',
        };
    }
    if (isMonorepoRelease && input.command.versionOverride) {
        return {
            ok: false,
            error:
                "`/approve as <version>` doesn't apply in a monorepo — each package has its own " +
                'version. Use `/approve` (auto-suggest per package) or `/approve <name>:<bump>` ' +
                '(per-package override) instead.',
        };
    }

    // Conversely, per-package overrides only make sense in a monorepo.
    if (!isMonorepoRelease && input.command.packageBumpOverrides.size > 0) {
        return {
            ok: false,
            error:
                'Per-package bump overrides like `name:minor` only apply in monorepos. ' +
                "This repo isn't a monorepo (or no packages have attributed PRs since the last tag). " +
                'Use `/approve patch|minor|major` instead.',
        };
    }

    // Validate that every overridden package name is actually present in the
    // release plan. Catches typos early ("@acme/aip" instead of "@acme/api")
    // rather than silently ignoring the override.
    if (input.command.packageBumpOverrides.size > 0) {
        const known = new Set(report.packages.map((p) => p.name));
        const unknown: string[] = [];
        for (const name of input.command.packageBumpOverrides.keys()) {
            if (!known.has(name)) unknown.push(name);
        }
        if (unknown.length > 0) {
            return {
                ok: false,
                error:
                    `Unknown package${unknown.length === 1 ? '' : 's'} in override: ` +
                    `${unknown.map((n) => `\`${n}\``).join(', ')}. ` +
                    `This release includes: ${report.packages
                        .map((p) => `\`${p.name}\``)
                        .join(', ')}.`,
            };
        }
    }

    const finalBump: BumpType = input.command.bumpOverride ?? report.suggestedBump;
    const finalVersion = input.command.versionOverride
        ? input.command.versionOverride
        : isMonorepoRelease
          ? report.suggestedVersion // event-id; per-package versions live in `packages`
          : computeFinalVersion(scheme, finalBump, report, config);

    // Per-package plans: carry forward from the report preview, OR re-derive
    // with user-supplied `name:bump` overrides applied (M3.4). Re-derivation
    // uses the same `buildPackagePlans` the report did, so the preview and
    // approved plans differ only in the overridden packages' bump/version
    // (and the cascading changelog content + tag name).
    let packages: PackageReleasePlan[] = report.packages;
    if (isMonorepoRelease && report.monorepoInfo && input.command.packageBumpOverrides.size > 0) {
        packages = buildPackagePlans({
            monorepoInfo: report.monorepoInfo,
            branch: report.baseBranch,
            config,
            bumpOverrides: input.command.packageBumpOverrides,
        });
    }

    // Single-repo: regenerate the on-disk changelog deterministically.
    // Monorepo: build a root aggregator that lists the release event with
    // pointers into each per-package CHANGELOG. Per-package content lives on
    // `packages[*].changelogContent`.
    const changelogContent = isMonorepoRelease
        ? buildRootMonorepoChangelogEntry(finalVersion, packages, new Date())
        : deterministicReport({
              prs: report.prs,
              suggestedBump: finalBump,
              suggestedVersion: finalVersion,
              config,
          }).changelogPreview;

    // Carry the user-facing summary forward from the report preview. Unlike
    // the changelog (deterministic, reproducible from PRs), the summary IS
    // the AI's prose contribution — we publish what the user approved, not a
    // freshly-regenerated fallback. Version + date get re-stamped because the
    // user may have used `/approve as X.Y.Z` or simply approved days after
    // generating the report.
    const releaseSummary: ReleaseSummary = restampSummary(
        report.summaryPreview,
        finalVersion,
        new Date(),
    );

    const plan: ReleasePlan = {
        repoOwner: input.owner,
        repoName: input.repo,
        baseBranch: report.baseBranch,
        bumpType: finalBump,
        currentVersion: report.currentVersion,
        nextVersion: finalVersion,
        lastTag: report.lastTag,
        prs: report.prs,
        changelogContent,
        releaseSummary,
        isMonorepo: report.isMonorepo,
        monorepoInfo: report.monorepoInfo,
        packages,
        isDraft: input.command.isDraft,
        isDryRun: input.command.isDryRun,
        issueNumber: input.issueNumber,
        approvedBy: input.approvedBy,
        approvedAt: new Date().toISOString(),
    };

    return { ok: true, plan, empty: false };
}

/**
 * Root CHANGELOG entry for a monorepo release event. Lists which packages
 * shipped at which versions with deep-links into each package's own
 * CHANGELOG.md. Per-package detail lives next to the package; the root entry
 * is just an index.
 */
function buildRootMonorepoChangelogEntry(
    eventId: string,
    packages: PackageReleasePlan[],
    now: Date,
): string {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const date = `${yyyy}-${mm}-${dd}`;
    const lines: string[] = [`## [${eventId}] - ${date}`, '', 'Released:', ''];
    for (const pkg of packages) {
        const link = `[${pkg.changelogPath}](${pkg.changelogPath})`;
        lines.push(`- \`${pkg.name}@${pkg.nextVersion}\` — see ${link}`);
    }
    return lines.join('\n') + '\n';
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
    // The schema requires a valid `releaseSummary` even though this plan
    // never reaches the action (callers branch on `empty: true` and reply
    // with `noChangesComment` instead of dispatching). A minimal valid
    // placeholder keeps both the type and the zod boundary happy.
    const placeholder: ReleaseSummary = (() => {
        const versionLabel = currentVersion.startsWith('v')
            ? currentVersion.slice(1)
            : currentVersion;
        const intermediate: ReleaseSummary = {
            version: versionLabel,
            date: formatSummaryDate(new Date()),
            headline: 'No changes to release.',
            body: 'No PRs have merged since the last tag.',
            highlights: ['No new changes'],
            rawMarkdown: '',
        };
        return { ...intermediate, rawMarkdown: buildSummaryMarkdown(intermediate) };
    })();

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
        releaseSummary: placeholder,
        isMonorepo: false,
        monorepoInfo: null,
        packages: [],
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
            getContent: (params: { owner: string; repo: string; path: string }) => Promise<unknown>;
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
    /** Size of the serialized release_plan input, in bytes (UTF-8). */
    payloadBytes?: number;
}

/**
 * GitHub `workflow_dispatch` caps a single input at ~65 KB. We use 60 KB as
 * the soft limit so we fail with our OWN error message — readable, actionable
 * — instead of GitHub's generic "inputs are too large" string. The 5 KB
 * headroom also covers the issue_number + dry_run input bytes plus JSON
 * encoding overhead.
 */
const MAX_RELEASE_PLAN_BYTES = 60_000;

/**
 * Strip `ReleasePlan` fields that the action does not consume so the JSON
 * fits inside GitHub's workflow_dispatch input size limit.
 *
 * The action only reads pre-rendered artifacts (`changelogContent`,
 * `releaseSummary`, package metadata, version info) — it never touches `prs`,
 * `monorepoInfo`, or `packages[].prs` again after the bot built the changelog.
 * For monorepos with many packages × many PRs × many commits with bodies,
 * those duplicate-but-unused fields can balloon the payload by 10–100×.
 *
 * The corresponding zod schemas in `@tagline-sh/shared` default these fields
 * to `[]`/`null` on parse, so a slim plan validates identically to a full one
 * at the action boundary.
 */
export function slimPlanForDispatch(plan: ReleasePlan): Record<string, unknown> {
    return {
        ...plan,
        prs: [],
        monorepoInfo: null,
        packages: plan.packages.map((p) => ({ ...p, prs: [] })),
    };
}

/**
 * Dispatch the user's `release-agent.yml` workflow with the encoded plan.
 *
 * Pre-flight: confirm the workflow file exists. The "missing workflow" case is
 * extremely common for first-time installs, and a setup-instructions comment
 * is far more useful than a generic "could not dispatch" failure.
 *
 * Size handling: the plan is slimmed (see `slimPlanForDispatch`) and the
 * resulting bytes are checked against `MAX_RELEASE_PLAN_BYTES`. If the slim
 * plan STILL exceeds the limit (e.g. a monorepo with very large rendered
 * CHANGELOG entries), we surface a typed error instead of letting GitHub
 * reject the dispatch with its less-helpful "inputs are too large" string.
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

    const slim = slimPlanForDispatch(plan);
    const releasePlanJson = JSON.stringify(slim);
    const payloadBytes = Buffer.byteLength(releasePlanJson, 'utf8');

    if (payloadBytes > MAX_RELEASE_PLAN_BYTES) {
        return {
            dispatched: false,
            missingWorkflow: false,
            payloadBytes,
            error:
                `Release plan is ${payloadBytes} bytes after slimming, which exceeds the ` +
                `${MAX_RELEASE_PLAN_BYTES}-byte workflow_dispatch input limit. This typically ` +
                'happens on monorepos with many packages × many merged PRs since the last release. ' +
                'Workaround: cut a release more often, or open an issue at ' +
                'https://github.com/tagline-sh/tagline-sh/issues with the size + monorepo shape.',
        };
    }

    try {
        await octokit.rest.actions.createWorkflowDispatch({
            owner,
            repo,
            workflow_id: RELEASE_WORKFLOW_FILE,
            ref: plan.baseBranch,
            inputs: {
                release_plan: releasePlanJson,
                issue_number: String(plan.issueNumber),
                dry_run: plan.isDryRun ? 'true' : 'false',
            },
        });
        return { dispatched: true, missingWorkflow: false, payloadBytes };
    } catch (err) {
        return {
            dispatched: false,
            missingWorkflow: false,
            payloadBytes,
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
