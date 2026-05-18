import type { ReleasePlan } from '@tagline-sh/shared';
import { releaseBranchName, releaseTagName } from '@tagline-sh/shared';

export interface OpenPROctokit {
    rest: {
        pulls: {
            create: (params: {
                owner: string;
                repo: string;
                title: string;
                head: string;
                base: string;
                body: string;
            }) => Promise<{ data: { html_url: string; number: number } }>;
        };
    };
}

export interface OpenPRResult {
    prUrl: string;
    prNumber: number;
}

/**
 * Open the changelog/version PR from the release branch to the production
 * (base) branch. The PR body is the same changelog content that landed in the
 * GitHub release, giving reviewers a single source of truth.
 */
export async function openReleasePR(
    plan: ReleasePlan,
    octokit: OpenPROctokit,
): Promise<OpenPRResult> {
    const tag = releaseTagName(plan.nextVersion);
    const branch = releaseBranchName(plan.nextVersion);

    const res = await octokit.rest.pulls.create({
        owner: plan.repoOwner,
        repo: plan.repoName,
        title: `chore(release): ${tag}`,
        head: branch,
        base: plan.baseBranch,
        body: plan.changelogContent,
    });

    return { prUrl: res.data.html_url, prNumber: res.data.number };
}
