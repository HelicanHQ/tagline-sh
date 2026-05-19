import type { ReleasePlan } from '@tagline-sh/shared';
import { releaseTagName } from '@tagline-sh/shared';

export interface ReleaseOctokit {
    rest: {
        repos: {
            createRelease: (params: {
                owner: string;
                repo: string;
                tag_name: string;
                name: string;
                body: string;
                draft: boolean;
                prerelease: boolean;
            }) => Promise<{ data: { html_url: string } }>;
        };
    };
}

export interface CreateReleaseResult {
    releaseUrl: string;
}

/**
 * Create a GitHub release for the freshly-pushed tag.
 *
 * The release is marked `prerelease: true` whenever the version contains a
 * pre-release identifier (`-rc.N`, `-alpha.N`, etc.) so the GitHub UI badge
 * matches reality.
 */
export async function createGitHubRelease(
    plan: ReleasePlan,
    octokit: ReleaseOctokit,
): Promise<CreateReleaseResult> {
    const tag = releaseTagName(plan.nextVersion);
    const isPrerelease = /-(rc|alpha|beta|next)\./.test(plan.nextVersion);

    const res = await octokit.rest.repos.createRelease({
        owner: plan.repoOwner,
        repo: plan.repoName,
        tag_name: tag,
        name: tag,
        body: buildReleaseBody(plan),
        draft: plan.isDraft,
        prerelease: isPrerelease,
    });

    return { releaseUrl: res.data.html_url };
}

/**
 * Compose the GitHub release body: plain-language summary first (PLAN_ADDENDUM
 * §7), then a horizontal-rule separator, then the technical changelog.
 *
 * Rationale: anyone browsing the GitHub Releases page in a non-engineering
 * role sees the readable summary above the fold; developers scrolling for
 * detail get the conventional-commit changelog below. One artifact, two
 * audiences — see `memory/reddit_signal_2026_05.md` for the user-research
 * trail.
 */
function buildReleaseBody(plan: ReleasePlan): string {
    return [plan.releaseSummary.rawMarkdown, '', '---', '', plan.changelogContent].join('\n');
}
