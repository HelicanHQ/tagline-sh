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
        body: plan.changelogContent,
        draft: plan.isDraft,
        prerelease: isPrerelease,
    });

    return { releaseUrl: res.data.html_url };
}
