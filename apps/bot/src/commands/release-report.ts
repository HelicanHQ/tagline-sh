import type { PackageReleasePlan, ReleaseReport } from '@tagline-sh/shared';
import {
    aggregatePRBumps,
    attributePRsToPackages,
    buildPackagePlans,
    channelForBranch,
    computeChannelVersion,
    deriveLineVersions,
    detectMonorepo,
    deterministicReport,
    generateReport,
    getCurrentVersion,
    getPRsSinceLastTag,
    hydratePRs,
    monorepoEventId,
    OctokitGitHubReader,
    type ReaderOctokit,
    readRepoConfig,
    stableChannel,
} from '~/app/services';

export interface ReleaseReportInput {
    octokit: ReaderOctokit;
    owner: string;
    repo: string;
    branch?: string;
    /** Optional AI credentials. If absent, deterministic fallback is used. */
    ai?: { apiKey: string; baseUrl?: string; model?: string };
}

export interface ReleaseReportResult {
    /** Full report with AI reasoning + changelog preview. */
    report: ReleaseReport;
    /** Whether the AI call actually fired (false on fallback). */
    aiUsed: boolean;
}

/**
 * Generate a release report end-to-end. Does not post any comments — the
 * caller is responsible for rendering and posting to GitHub.
 *
 * This function is the single composition point for the bot's read services:
 *   config → monorepo → tags → PRs → commits → version math → AI/fallback
 */
export async function buildReleaseReport(input: ReleaseReportInput): Promise<ReleaseReportResult> {
    const reader = new OctokitGitHubReader(input.octokit);
    const repoRef = { owner: input.owner, repo: input.repo };

    const config = await readRepoConfig(reader, repoRef);
    const branch = input.branch ?? config.branches.production;

    // Resolve the release channel for this branch. An unknown branch (e.g. a
    // `--branch` pointed at something not configured) falls back to the stable
    // channel so the report still renders a clean version.
    const channel = channelForBranch(config, branch) ??
        stableChannel(config) ?? { branch, tier: 'stable' as const, suffix: null };

    const [monorepo, currentVersion, { prs: summaries, lastTag }, tags] = await Promise.all([
        detectMonorepo(reader, repoRef, branch),
        getCurrentVersion(reader, repoRef, branch),
        getPRsSinceLastTag(reader, repoRef, branch),
        reader.listTags(repoRef),
    ]);

    const hydrated = await hydratePRs(reader, repoRef, summaries);
    const parsedPRs = hydrated.map((h) => h.pr);

    const suggestedBump = aggregatePRBumps(parsedPRs);

    const monorepoInfo =
        monorepo.type === 'none'
            ? null
            : attributePRsToPackages(
                  monorepo,
                  hydrated.map((h) => ({ pr: h.pr, files: h.files })),
              );

    // M3: monorepos get per-package plans. The aggregate `suggestedVersion`
    // becomes an event-identifier date instead of a semver version — it
    // names the release event for the branch (`release/vevent-2026-05-19`)
    // and the PR title but is not a tag. Per-package tags ship via
    // `packages[*].tagName`. Single-repos keep the historical single-version
    // flow exactly as before.
    let packages: PackageReleasePlan[] = [];
    let suggestedVersion: string;
    if (monorepoInfo) {
        packages = buildPackagePlans({ monorepoInfo, branch, config, channel, tags });
        suggestedVersion = packages.length > 0 ? monorepoEventId() : currentVersion;
    } else {
        const { lastStableVersion, knownVersions } = deriveLineVersions(tags);
        suggestedVersion = computeChannelVersion({
            channel,
            lastStableVersion,
            currentVersion,
            bump: suggestedBump,
            scheme: config.versioning.scheme,
            pattern: config.versioning.pattern,
            knownVersions,
        });
    }

    let aiOutput;
    if (input.ai?.apiKey) {
        aiOutput = await generateReport(
            { prs: parsedPRs, suggestedBump, suggestedVersion, config },
            input.ai,
        );
    } else {
        aiOutput = deterministicReport({
            prs: parsedPRs,
            suggestedBump,
            suggestedVersion,
            config,
        });
    }

    const report: ReleaseReport = {
        repoOwner: input.owner,
        repoName: input.repo,
        baseBranch: branch,
        lastTag: lastTag?.name ?? null,
        lastTagDate: lastTag?.commitDate ?? null,
        prs: parsedPRs,
        suggestedBump,
        suggestedVersion,
        currentVersion,
        versioningScheme: config.versioning.scheme,
        reasoning: aiOutput.reasoning,
        changelogPreview: aiOutput.changelogPreview,
        summaryPreview: aiOutput.summary,
        isMonorepo: monorepoInfo !== null,
        monorepoInfo,
        packages,
        generatedAt: new Date().toISOString(),
    };

    return { report, aiUsed: aiOutput.aiUsed };
}
