import type { ReleaseReport } from '@tagline-sh/shared';
import {
    aggregatePRBumps,
    attributePRsToPackages,
    calculateNextVersion,
    detectMonorepo,
    deterministicReport,
    generateReport,
    getCurrentVersion,
    getPRsSinceLastTag,
    hydratePRs,
    OctokitGitHubReader,
    type ReaderOctokit,
    readRepoConfig,
} from '../services/index.js';

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
export async function buildReleaseReport(
    input: ReleaseReportInput,
): Promise<ReleaseReportResult> {
    const reader = new OctokitGitHubReader(input.octokit);
    const repoRef = { owner: input.owner, repo: input.repo };

    const config = await readRepoConfig(reader, repoRef);
    const branch = input.branch ?? config.branches.production;

    const [monorepo, currentVersion, { prs: summaries, lastTag }] = await Promise.all([
        detectMonorepo(reader, repoRef, branch),
        getCurrentVersion(reader, repoRef, branch),
        getPRsSinceLastTag(reader, repoRef, branch),
    ]);

    const hydrated = await hydratePRs(reader, repoRef, summaries);
    const parsedPRs = hydrated.map((h) => h.pr);

    const suggestedBump = aggregatePRBumps(parsedPRs);
    const suggestedVersion =
        suggestedBump === 'none'
            ? currentVersion
            : calculateNextVersion(currentVersion, suggestedBump, branch, config);

    const monorepoInfo =
        monorepo.type === 'none'
            ? null
            : attributePRsToPackages(
                  monorepo,
                  hydrated.map((h) => ({ pr: h.pr, files: h.files })),
              );

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
        isMonorepo: monorepoInfo !== null,
        monorepoInfo,
        generatedAt: new Date().toISOString(),
    };

    return { report, aiUsed: aiOutput.aiUsed };
}
