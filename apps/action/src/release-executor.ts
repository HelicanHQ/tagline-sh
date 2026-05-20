import * as core from '@actions/core';
import {
    releaseBranchName,
    releaseTagName,
    type ReleasePlan,
    type ReleaseResult,
} from '@tagline-sh/shared';
import { bumpVersion } from '~/app/steps/bump-version';
import { writeChangelog } from '~/app/steps/write-changelog';
import {
    commitAndPushBranch,
    tagMergeCommit,
    type GitOpsDeps,
    type TagMergeOctokit,
} from '~/app/steps/git-operations';
import {
    buildReleaseBody,
    createGitHubReleaseFor,
    type ReleaseOctokit,
} from '~/app/steps/github-release';
import {
    extractFinalizePlan,
    openReleasePR,
    type FinalizePlanPayload,
    type OpenPROctokit,
} from '~/app/steps/open-pr';
import { postCompletionComment, type CommentOctokit } from '~/app/steps/post-completion-comment';

/**
 * Octokit endpoint used by the push-event Phase B path. We can't rely on
 * `pull_request: closed` because PRs opened by the default `GITHUB_TOKEN`
 * (which Phase A uses) never fire `pull_request` events when merged — this
 * is the documented GitHub Actions anti-recursion behavior. So we trigger
 * Phase B from `push: [main, master]` and look up the merged PR ourselves.
 */
export interface PullLookupOctokit {
    rest: {
        repos: {
            listPullRequestsAssociatedWithCommit: (params: {
                owner: string;
                repo: string;
                commit_sha: string;
            }) => Promise<{
                data: Array<{
                    number: number;
                    merge_commit_sha: string | null;
                    head: { ref: string };
                    merged_at: string | null;
                    body: string | null;
                }>;
            }>;
        };
    };
}

/** Octokit intersection used across both phases. */
export type ExecutorOctokit = ReleaseOctokit &
    OpenPROctokit &
    CommentOctokit &
    TagMergeOctokit &
    PullLookupOctokit;

export interface ExecutorDeps {
    octokit: ExecutorOctokit;
    workspaceRoot: string;
    git?: GitOpsDeps['git'];
}

/**
 * Build the finalize payload that ships inside the release PR body. Phase
 * B parses this back out at merge time and uses it verbatim to create tags
 * and GitHub Releases — no re-derivation from repo state needed.
 */
function buildFinalizePayload(plan: ReleasePlan): FinalizePlanPayload {
    const isMonorepo = plan.packages.length > 0;
    if (!isMonorepo) {
        const tag = releaseTagName(plan.nextVersion);
        return {
            nextVersion: plan.nextVersion,
            tags: [tag],
            releaseBodies: [buildReleaseBody(plan)],
            releaseNames: [tag],
            draft: plan.isDraft,
            issueNumber: plan.issueNumber,
            summaryMarkdown: plan.releaseSummary.rawMarkdown,
        };
    }
    // Monorepo: one tag per package, each release body = repo-level summary
    // + that package's changelog excerpt. The repo-level summary stays
    // identical across packages (PLAN_ADDENDUM §9 — summary is repo-level).
    const tags = plan.packages.map((p) => p.tagName);
    const releaseBodies = plan.packages.map((p) =>
        [plan.releaseSummary.rawMarkdown, '', '---', '', p.changelogContent].join('\n'),
    );
    const releaseNames = plan.packages.map((p) => p.tagName);
    return {
        nextVersion: plan.nextVersion,
        tags,
        releaseBodies,
        releaseNames,
        draft: plan.isDraft,
        issueNumber: plan.issueNumber,
        summaryMarkdown: plan.releaseSummary.rawMarkdown,
    };
}

/**
 * Phase A — propose.
 *
 * Bumps versions, writes CHANGELOG.md, commits, pushes the release branch,
 * opens a PR. Does **NOT** create a tag or GitHub Release. Those happen in
 * `executeFinalizeRelease` when the PR is merged.
 *
 * The release PR body carries a hidden plan marker that Phase B reads to
 * know exactly what to tag and release without re-inferring from the merge
 * commit.
 */
export async function executeProposeRelease(
    plan: ReleasePlan,
    deps: ExecutorDeps,
): Promise<ReleaseResult> {
    const tag = releaseTagName(plan.nextVersion);
    const branch = releaseBranchName(plan.nextVersion);
    let prUrl: string | null = null;

    try {
        core.info(`Step 1/5: Bumping versions to ${plan.nextVersion}`);
        const bumped = await bumpVersion(plan, deps.workspaceRoot);
        core.info(`  bumped ${bumped.files.length} file(s)`);

        core.info(`Step 2/5: Writing CHANGELOG.md`);
        const changelog = await writeChangelog(plan, deps.workspaceRoot);
        core.info(`  wrote ${changelog.files.length} file(s)`);

        if (plan.isDryRun) {
            core.info('Dry run: skipping git/PR writes.');
            await tryPostCompletion(plan, deps.octokit, {
                kind: 'propose',
                prUrl: null,
                dryRun: true,
            });
            return {
                success: true,
                nextVersion: plan.nextVersion,
                tagName: tag,
                releaseUrl: null,
                prUrl: null,
                error: null,
                isDryRun: true,
            };
        }

        core.info(`Step 3/5: Commit + push branch ${branch}`);
        const git = await commitAndPushBranch(
            plan,
            deps.workspaceRoot,
            deps.git ? { git: deps.git } : {},
        );
        core.info(`  branch=${git.branch} sha=${git.commitSha}`);

        core.info(`Step 4/5: Opening release PR`);
        const payload = buildFinalizePayload(plan);
        const pr = await openReleasePR(plan, deps.octokit, payload);
        prUrl = pr.prUrl;
        core.info(`  ${prUrl}`);
        // Sanity log: the release PR body MUST contain the plan marker for
        // Phase B to know what to tag. We log presence + payload size so a
        // future "Phase B couldn't find the marker" is debuggable from this
        // run's log alone.
        core.info(
            `  embedded plan marker: tags=${payload.tags.length} draft=${payload.draft} issue=${payload.issueNumber}`,
        );

        core.info(`Step 5/5: Posting acknowledgement comment`);
        await tryPostCompletion(plan, deps.octokit, {
            kind: 'propose',
            prUrl,
            dryRun: false,
        });

        core.setOutput('version', plan.nextVersion);
        core.setOutput('tag', tag);
        core.setOutput('pr_url', prUrl);

        return {
            success: true,
            nextVersion: plan.nextVersion,
            tagName: tag,
            releaseUrl: null,
            prUrl,
            error: null,
            isDryRun: false,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.error(`Release proposal failed: ${message}`);
        await tryPostCompletion(plan, deps.octokit, {
            kind: 'propose',
            prUrl,
            dryRun: plan.isDryRun,
            error: message,
        });
        return {
            success: false,
            nextVersion: plan.nextVersion,
            tagName: tag,
            releaseUrl: null,
            prUrl,
            error: message,
            isDryRun: plan.isDryRun,
        };
    }
}

export interface FinalizeInput {
    repoOwner: string;
    repoName: string;
    /** Merge commit SHA — what the tag(s) point at. */
    mergeSha: string;
    /** The release PR number — finalize comments back on it. */
    prNumber: number;
    /** Raw PR body containing the embedded plan marker. */
    prBody: string | null;
    /** Fallback: head ref of the merged PR (used when the marker is missing). */
    headRef: string;
}

/**
 * Find the release PR associated with a merge commit SHA.
 *
 * Phase B is driven by `push: [main, master]` because PRs opened with
 * `GITHUB_TOKEN` never fire `pull_request: closed` events when merged. The
 * push event hands us a commit SHA; we use this to map back to the PR that
 * was merged and pull the embedded plan marker out of its body.
 *
 * Returns `null` for any push that isn't a release-PR merge — that's the
 * majority of pushes to `main` and not an error.
 */
export async function findReleasePRForCommit(
    octokit: PullLookupOctokit,
    repoOwner: string,
    repoName: string,
    sha: string,
): Promise<FinalizeInput | null> {
    const res = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner: repoOwner,
        repo: repoName,
        commit_sha: sha,
    });
    const releasePR = res.data.find(
        (pr) =>
            pr.merge_commit_sha === sha &&
            pr.merged_at !== null &&
            pr.head.ref.startsWith('release/'),
    );
    if (!releasePR) return null;
    return {
        repoOwner,
        repoName,
        mergeSha: sha,
        prNumber: releasePR.number,
        prBody: releasePR.body,
        headRef: releasePR.head.ref,
    };
}

/**
 * Phase B — finalize.
 *
 * Triggered by `pull_request: closed.merged` on a `release/*` branch.
 * Parses the plan marker from the merged PR body, then creates the tag(s)
 * at the merge SHA and publishes a GitHub Release per tag. Comments back
 * on the merged PR with the release URLs.
 */
export async function executeFinalizeRelease(
    input: FinalizeInput,
    deps: ExecutorDeps,
): Promise<ReleaseResult> {
    const payload = extractFinalizePlan(input.prBody);

    if (!payload) {
        const message =
            'Tagline could not find the embedded plan marker in the release PR body. ' +
            'The release PR may have been edited or opened by hand. Skipping tag + release.';
        core.warning(message);
        return {
            success: false,
            nextVersion: '0.0.0',
            tagName: '',
            releaseUrl: null,
            prUrl: null,
            error: message,
            isDryRun: false,
        };
    }

    try {
        core.info(`Step 1/3: Tagging merge commit ${input.mergeSha} with ${payload.tags.length} tag(s)`);
        const tagged = await tagMergeCommit(
            {
                repoOwner: input.repoOwner,
                repoName: input.repoName,
                sha: input.mergeSha,
                tags: payload.tags,
            },
            deps.octokit,
        );
        core.info(`  created: [${tagged.created.join(', ')}] skipped: [${tagged.skipped.join(', ')}]`);

        core.info(`Step 2/3: Creating ${payload.tags.length} GitHub Release(s)`);
        const releaseUrls: string[] = [];
        for (let i = 0; i < payload.tags.length; i += 1) {
            const tag = payload.tags[i]!;
            const body = payload.releaseBodies[i] ?? '';
            const name = payload.releaseNames[i] ?? tag;
            try {
                const rel = await createGitHubReleaseFor(
                    {
                        repoOwner: input.repoOwner,
                        repoName: input.repoName,
                        tag,
                        name,
                        body,
                        draft: payload.draft,
                    },
                    deps.octokit,
                );
                releaseUrls.push(rel.releaseUrl);
                core.info(`  ${tag} → ${rel.releaseUrl}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (/already_exists|already exists/i.test(message)) {
                    core.info(`  ${tag} → release already exists, skipping`);
                    continue;
                }
                throw err;
            }
        }

        core.info(`Step 3/3: Commenting on PR #${input.prNumber}`);
        await tryPostFinalizeComment({
            octokit: deps.octokit,
            repoOwner: input.repoOwner,
            repoName: input.repoName,
            prNumber: input.prNumber,
            tags: payload.tags,
            releaseUrls,
            summaryMarkdown: payload.summaryMarkdown,
        });

        const primaryTag = payload.tags[0] ?? releaseTagName(payload.nextVersion);
        const primaryUrl = releaseUrls[0] ?? null;

        core.setOutput('version', payload.nextVersion);
        core.setOutput('tag', primaryTag);
        core.setOutput('release_url', primaryUrl);

        return {
            success: true,
            nextVersion: payload.nextVersion,
            tagName: primaryTag,
            releaseUrl: primaryUrl,
            prUrl: null,
            error: null,
            isDryRun: false,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.error(`Release finalize failed: ${message}`);
        return {
            success: false,
            nextVersion: payload.nextVersion,
            tagName: payload.tags[0] ?? '',
            releaseUrl: null,
            prUrl: null,
            error: message,
            isDryRun: false,
        };
    }
}

/**
 * @deprecated Use `executeProposeRelease` directly. Kept for tests still
 * importing the old name; behavior is now propose-only (no tag, no release
 * during this phase — those move to `executeFinalizeRelease`).
 */
export const executeRelease = executeProposeRelease;

type ProposeCompletionContext = {
    kind: 'propose';
    prUrl: string | null;
    dryRun: boolean;
    error?: string;
};

async function tryPostCompletion(
    plan: ReleasePlan,
    octokit: ExecutorOctokit,
    ctx: ProposeCompletionContext,
): Promise<void> {
    try {
        await postCompletionComment(plan, octokit, {
            releaseUrl: null,
            prUrl: ctx.prUrl,
            dryRun: ctx.dryRun,
            ...(ctx.error ? { error: ctx.error } : {}),
            phase: 'propose',
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.warning(
            `Could not post completion comment (release itself was not affected): ${message}. ` +
                'If you see "Resource not accessible by integration", add `issues: write` to your workflow permissions.',
        );
    }
}

async function tryPostFinalizeComment(args: {
    octokit: ExecutorOctokit;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    tags: string[];
    releaseUrls: string[];
    summaryMarkdown: string;
}): Promise<void> {
    const lines: string[] = [];
    if (args.tags.length === 1) {
        lines.push(`Released \`${args.tags[0]}\` 🎉`);
    } else {
        lines.push(`Released ${args.tags.length} packages 🎉`);
    }
    lines.push('');
    for (let i = 0; i < args.tags.length; i += 1) {
        const url = args.releaseUrls[i];
        if (url) lines.push(`- \`${args.tags[i]}\` → ${url}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Ready to share:**');
    lines.push('');
    lines.push(args.summaryMarkdown.trimEnd());
    try {
        await args.octokit.rest.issues.createComment({
            owner: args.repoOwner,
            repo: args.repoName,
            issue_number: args.prNumber,
            body: lines.join('\n'),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.warning(`Could not post finalize comment: ${message}.`);
    }
}
