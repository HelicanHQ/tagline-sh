import { promises as fs } from 'node:fs';
import * as core from '@actions/core';
import { ReleasePlanSchema } from '@tagline-sh/shared';
import {
    executeProposeRelease,
    executeFinalizeRelease,
    findReleasePRForCommit,
    type ExecutorOctokit,
} from '~/app/release-executor';

interface PullRequestEvent {
    action?: string;
    pull_request?: {
        number: number;
        merged: boolean;
        merge_commit_sha?: string | null;
        head?: { ref?: string };
        base?: { ref?: string };
        body?: string | null;
    };
    repository?: {
        name: string;
        owner: { login: string };
    };
}

export async function runPropose(octokit: ExecutorOctokit, workspaceRoot: string): Promise<void> {
    const releasePlanInput = core.getInput('release_plan', { required: true });
    const issueNumberRaw = core.getInput('issue_number');
    const dryRunRaw = core.getInput('dry_run');

    const plan = ReleasePlanSchema.parse(JSON.parse(releasePlanInput));

    if (dryRunRaw === 'true') plan.isDryRun = true;
    if (issueNumberRaw && /^\d+$/.test(issueNumberRaw)) {
        plan.issueNumber = Number(issueNumberRaw);
    }

    const result = await executeProposeRelease(plan, { octokit, workspaceRoot });
    if (!result.success) {
        core.setFailed(result.error ?? 'Release proposal failed');
    }
}

export async function runFinalize(octokit: ExecutorOctokit, workspaceRoot: string): Promise<void> {
    const eventPath = process.env['GITHUB_EVENT_PATH'];
    if (!eventPath) {
        core.setFailed('GITHUB_EVENT_PATH unset on pull_request event — cannot finalize.');
        return;
    }
    const raw = await fs.readFile(eventPath, 'utf8');
    const event = JSON.parse(raw) as PullRequestEvent;

    // Echo the key fields immediately so a misrouted run is obvious in the log.
    core.info(
        `Phase B input — action=${event.action ?? '<none>'} merged=${
            event.pull_request?.merged ?? '<none>'
        } head=${event.pull_request?.head?.ref ?? '<none>'} base=${
            event.pull_request?.base?.ref ?? '<none>'
        } number=${event.pull_request?.number ?? '<none>'} merge_sha=${
            event.pull_request?.merge_commit_sha ?? '<none>'
        }`,
    );

    if (event.action !== 'closed') {
        // GitHub Actions filters with `types: [closed]` should prevent this,
        // but if the workflow YAML widened the types, we'd be here. Loud so
        // the user catches the misconfiguration.
        core.warning(
            `pull_request.${event.action ?? '?'} — Phase B only runs on 'closed'. Check your workflow's pull_request types filter.`,
        );
        return;
    }
    if (!event.pull_request?.merged) {
        // Closing without merging is the documented "cancel the release"
        // path. Stay quiet — this is intentional UX, not an error.
        core.info('PR was closed without merging — release cancelled, no tag created.');
        return;
    }
    const headRef = event.pull_request.head?.ref ?? '';
    if (!headRef.startsWith('release/')) {
        core.info(`PR head ref is "${headRef}" — not a release/* branch, skipping.`);
        return;
    }

    const mergeSha = event.pull_request.merge_commit_sha;
    if (!mergeSha) {
        core.setFailed(
            'Merged PR has no merge_commit_sha — GitHub may still be computing the merge commit. Re-run the workflow in 30s.',
        );
        return;
    }

    const owner = event.repository?.owner.login;
    const name = event.repository?.name;
    if (!owner || !name) {
        core.setFailed('Could not resolve repository owner/name from event payload.');
        return;
    }

    // PR body diagnostic — the most common silent failure is the hidden plan
    // marker missing from the body (PR edited by hand, or the propose-phase
    // PR was opened by an older action bundle). Surfacing presence here saves
    // the user from staring at "Phase B did nothing" with no clue why.
    const body = event.pull_request.body ?? '';
    const markerPresent = body.includes('<!-- tagline-plan-v1');
    core.info(`Phase B body inspection — length=${body.length} marker_present=${markerPresent}`);
    if (!markerPresent && body.length > 0) {
        // Show body tail so the user can SEE that the marker really isn't there
        // (or has been corrupted by a hand-edit). Truncated to keep the log
        // readable.
        const tail = body.slice(Math.max(0, body.length - 400));
        core.info(`PR body tail (last 400 chars):\n${tail}`);
    }

    const result = await executeFinalizeRelease(
        {
            repoOwner: owner,
            repoName: name,
            mergeSha,
            prNumber: event.pull_request.number,
            prBody: event.pull_request.body ?? null,
            headRef,
        },
        { octokit, workspaceRoot },
    );
    if (!result.success) {
        core.setFailed(result.error ?? 'Release finalize failed');
    } else {
        core.info(
            `Phase B done — tagged ${result.tagName} at ${mergeSha}, release: ${result.releaseUrl ?? '<no release URL>'}`,
        );
    }
}

/**
 * Via `push` event. The canonical Phase B path — works regardless of
 * which token opened the release PR. We get a commit SHA from the push event,
 * ask GitHub which PRs are associated with that commit, and finalize iff one
 * of them is a merged `release/*` PR whose `merge_commit_sha` matches.
 *
 * Non-release pushes to `main` are the common case and a clean no-op: we
 * just log and exit. The cost is one `listPullRequestsAssociatedWithCommit`
 * API call per push to `main`, which is negligible.
 */
export async function runFinalizeFromPush(
    octokit: ExecutorOctokit,
    workspaceRoot: string,
): Promise<void> {
    const sha = process.env['GITHUB_SHA'];
    const repoEnv = process.env['GITHUB_REPOSITORY'];
    if (!sha || !repoEnv) {
        core.setFailed(
            'GITHUB_SHA or GITHUB_REPOSITORY unset on push event — cannot determine commit to finalize.',
        );
        return;
    }
    const [owner, name] = repoEnv.split('/');
    if (!owner || !name) {
        core.setFailed(`GITHUB_REPOSITORY is malformed: "${repoEnv}"`);
        return;
    }

    const finalizeInput = await findReleasePRForCommit(octokit, owner, name, sha);
    if (!finalizeInput) {
        core.info(
            `Push ${sha} is not a release-PR merge — no Phase B work to do (this is normal for non-release pushes).`,
        );
        return;
    }

    // Body diagnostic for the same reasons we do it in runFinalize — the
    // most common silent failure is a missing/edited plan marker. Telling
    // the user immediately saves significant debugging time.
    const body = finalizeInput.prBody ?? '';
    const markerPresent = body.includes('<!-- tagline-plan-v1');
    core.info(
        `Detected release PR #${finalizeInput.prNumber} (head=${finalizeInput.headRef}) merged at ${sha}. body length=${body.length} marker_present=${markerPresent}`,
    );
    if (!markerPresent && body.length > 0) {
        const tail = body.slice(Math.max(0, body.length - 400));
        core.info(`PR body tail (last 400 chars):\n${tail}`);
    }

    const result = await executeFinalizeRelease(finalizeInput, { octokit, workspaceRoot });
    if (!result.success) {
        core.setFailed(result.error ?? 'Release finalize failed');
    } else {
        core.info(
            `Phase B done — tagged ${result.tagName} at ${sha}, release: ${result.releaseUrl ?? '<no release URL>'}`,
        );
    }
}
