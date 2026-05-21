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
 * Hidden marker embedded in the release PR body. Phase B parses this back
 * out at merge time to know exactly what to tag and release without re-
 * inferring from repo state. Base64-encoded so changelog/summary content
 * containing `-->` or other HTML-comment-hostile substrings can't corrupt
 * the marker.
 */
const PLAN_MARKER_START = '<!-- tagline-plan-v1';
const PLAN_MARKER_END = '-->';

export interface FinalizePlanPayload {
    nextVersion: string;
    /** Tag(s) to create at the merge commit. Single-repo: 1. Monorepo: N. */
    tags: string[];
    /**
     * Per-tag release body (markdown). Same length and order as `tags`. The
     * first element is the canonical "event" release body for single-repo;
     * per-package monorepo bodies are each package's changelog excerpt with
     * the repo-level summary prepended.
     */
    releaseBodies: string[];
    /** Display name per release. Same length / order as `tags`. */
    releaseNames: string[];
    draft: boolean;
    /** Issue number that originated `/approve`. 0 means "no ack to attach to". */
    issueNumber: number;
    /**
     * Repo-level summary `rawMarkdown` — used in the finalize comment's
     * "Ready to share" block. Kept separate from `releaseBodies` to avoid
     * re-parsing it back out per package.
     */
    summaryMarkdown: string;
}

export function encodeFinalizePlan(payload: FinalizePlanPayload): string {
    const json = JSON.stringify(payload);
    return Buffer.from(json, 'utf8').toString('base64');
}

export function extractFinalizePlan(prBody: string | null | undefined): FinalizePlanPayload | null {
    if (!prBody) return null;
    const startIdx = prBody.indexOf(PLAN_MARKER_START);
    if (startIdx === -1) return null;
    const afterStart = startIdx + PLAN_MARKER_START.length;
    const endIdx = prBody.indexOf(PLAN_MARKER_END, afterStart);
    if (endIdx === -1) return null;
    const encoded = prBody.slice(afterStart, endIdx).trim();
    try {
        const json = Buffer.from(encoded, 'base64').toString('utf8');
        return JSON.parse(json) as FinalizePlanPayload;
    } catch {
        return null;
    }
}

function buildPRBody(plan: ReleasePlan, payload: FinalizePlanPayload): string {
    return [
        plan.releaseSummary.rawMarkdown,
        '',
        '---',
        '',
        '_New entry — will be prepended above existing entries in `CHANGELOG.md` when this PR merges. Prior history is preserved._',
        '',
        plan.changelogContent,
        '',
        '---',
        '',
        '_Once you merge this PR, Tagline will tag the merge commit and publish a GitHub Release. Close the PR to cancel — no tag is created until merge._',
        '',
        `${PLAN_MARKER_START}`,
        encodeFinalizePlan(payload),
        PLAN_MARKER_END,
    ].join('\n');
}

/**
 * Open the release PR from the release branch to the production (base)
 * branch. The body carries the plain-language summary, the technical
 * changelog, and a hidden machine-readable plan marker that the finalize
 * step parses back out to drive tag + release creation at merge time.
 */
export async function openReleasePR(
    plan: ReleasePlan,
    octokit: OpenPROctokit,
    payload: FinalizePlanPayload,
): Promise<OpenPRResult> {
    const tag = releaseTagName(plan.nextVersion);
    const branch = releaseBranchName(plan.nextVersion);

    const res = await octokit.rest.pulls.create({
        owner: plan.repoOwner,
        repo: plan.repoName,
        title: `chore(release): ${tag}`,
        head: branch,
        base: plan.baseBranch,
        body: buildPRBody(plan, payload),
    });

    return { prUrl: res.data.html_url, prNumber: res.data.number };
}
