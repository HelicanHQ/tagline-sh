import semver from 'semver';
import type {
    GitHubReader,
    PullRequestSummary,
    RepoRef,
    TagRef,
} from './github-reader.js';
import { parsePR } from './commit-parser.js';
import type { ParsedPR } from '@tagline-sh/shared';

// Matches `v1.2.3`, `v1.2.3-rc.0`, `1.2.3` etc. Tightened to require a
// numeric major to avoid catching arbitrary git tags.
const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+([+-][\w.]+)?$/;

/**
 * Newest semver-compliant tag in the repo, or `null` if none exist.
 * Sorts strictly by semver rather than by tag creation date — a back-port tag
 * `v1.0.1` created after `v2.0.0` is not "newer" for release purposes.
 */
export async function getLastReleaseTag(
    reader: GitHubReader,
    repo: RepoRef,
): Promise<TagRef | null> {
    const tags = await reader.listTags(repo);
    const semverTags = tags.filter((t) => SEMVER_TAG_RE.test(t.name));
    if (semverTags.length === 0) return null;

    semverTags.sort((a, b) => {
        const av = semver.coerce(a.name)?.version ?? '0.0.0';
        const bv = semver.coerce(b.name)?.version ?? '0.0.0';
        return semver.rcompare(av, bv);
    });
    return semverTags[0] ?? null;
}

interface MinimalPackageJson {
    version?: string;
}

/**
 * Resolve the project's current version. Order of preference:
 *   1. root `package.json#version` on the given ref (typically the default branch)
 *   2. The last release tag's `name`, with the leading `v` stripped
 *   3. `0.0.0` as a last resort, so first-time runs don't crash
 */
export async function getCurrentVersion(
    reader: GitHubReader,
    repo: RepoRef,
    ref?: string,
): Promise<string> {
    const raw = await reader.getFileContent(repo, 'package.json', ref);
    if (raw) {
        try {
            const pkg = JSON.parse(raw) as MinimalPackageJson;
            if (pkg.version && semver.valid(pkg.version)) return pkg.version;
        } catch {
            // fall through
        }
    }

    const tag = await getLastReleaseTag(reader, repo);
    if (tag) {
        const stripped = tag.name.replace(/^v/, '');
        if (semver.valid(stripped)) return stripped;
    }

    return '0.0.0';
}

/**
 * Merged PRs targeting `branch`, since the last release tag (or all PRs if no
 * tag exists yet — i.e. this is the first release).
 */
export async function getPRsSinceLastTag(
    reader: GitHubReader,
    repo: RepoRef,
    branch: string,
): Promise<{ prs: PullRequestSummary[]; lastTag: TagRef | null }> {
    const lastTag = await getLastReleaseTag(reader, repo);
    const since = lastTag?.commitDate ?? null;
    const prs = await reader.listMergedPRs(repo, branch, since);
    return { prs, lastTag };
}

export interface PRWithFiles {
    pr: ParsedPR;
    /** Files changed in this PR (filenames relative to repo root). */
    files: string[];
    nonConformant: boolean;
}

/**
 * Hydrate each PR summary with its commits + changed files, parse it into a
 * `ParsedPR`, and return everything the report and monorepo attribution need.
 *
 * Performs N×2 GitHub API calls (listPRCommits + listPRFiles) — caller decides
 * whether to batch via Promise.all. For typical release sizes (<50 PRs) the
 * sequential cost is negligible compared to the AI call.
 */
export async function hydratePRs(
    reader: GitHubReader,
    repo: RepoRef,
    summaries: PullRequestSummary[],
): Promise<PRWithFiles[]> {
    return Promise.all(
        summaries.map(async (summary) => {
            const [commits, files] = await Promise.all([
                reader.listPRCommits(repo, summary.number),
                reader.listPRFiles(repo, summary.number),
            ]);
            const { pr, nonConformant } = parsePR(summary, commits);
            return {
                pr,
                files: files.map((f) => f.filename),
                nonConformant,
            };
        }),
    );
}
