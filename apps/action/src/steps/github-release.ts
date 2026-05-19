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

export interface CreateReleaseInput {
    repoOwner: string;
    repoName: string;
    tag: string;
    /** Display name for the release (usually equals `tag`). */
    name: string;
    body: string;
    draft: boolean;
    /**
     * If undefined, computed from the tag name: tags containing
     * `-rc.N` / `-alpha.N` / `-beta.N` / `-next.N` are pre-releases.
     */
    prerelease?: boolean;
}

export interface CreateReleaseResult {
    releaseUrl: string;
}

function isPrereleaseTag(tag: string): boolean {
    return /-(rc|alpha|beta|next)\./.test(tag);
}

/**
 * Create a GitHub Release for a specific tag. Used by Phase B.
 *
 * Decoupled from `ReleasePlan` because in finalize mode the caller may not
 * have a plan — it's deriving inputs from the merged PR's body and the
 * repo state at the merge SHA.
 */
export async function createGitHubReleaseFor(
    input: CreateReleaseInput,
    octokit: ReleaseOctokit,
): Promise<CreateReleaseResult> {
    const res = await octokit.rest.repos.createRelease({
        owner: input.repoOwner,
        repo: input.repoName,
        tag_name: input.tag,
        name: input.name,
        body: input.body,
        draft: input.draft,
        prerelease: input.prerelease ?? isPrereleaseTag(input.tag),
    });
    return { releaseUrl: res.data.html_url };
}

/**
 * Compose the GitHub release body: plain-language summary first
 * (PLAN_ADDENDUM §7), then a horizontal-rule separator, then the technical
 * changelog. Anyone browsing the GitHub Releases page sees the readable
 * summary above the fold; developers scrolling for detail get the
 * conventional-commit changelog below.
 */
export function buildReleaseBody(plan: ReleasePlan): string {
    return [plan.releaseSummary.rawMarkdown, '', '---', '', plan.changelogContent].join('\n');
}

/**
 * @deprecated Phase A no longer creates releases — this exists only for
 * backwards compatibility with callers that still pass the full plan. Phase
 * B should call `createGitHubReleaseFor` directly with explicit inputs.
 */
export async function createGitHubRelease(
    plan: ReleasePlan,
    octokit: ReleaseOctokit,
): Promise<CreateReleaseResult> {
    const tag = releaseTagName(plan.nextVersion);
    return createGitHubReleaseFor(
        {
            repoOwner: plan.repoOwner,
            repoName: plan.repoName,
            tag,
            name: tag,
            body: buildReleaseBody(plan),
            draft: plan.isDraft,
            prerelease: isPrereleaseTag(plan.nextVersion),
        },
        octokit,
    );
}
