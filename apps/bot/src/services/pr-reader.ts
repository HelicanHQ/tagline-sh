import semver from 'semver';
import type {
    GitHubReader,
    PullRequestSummary,
    RepoRef,
    TagRef,
} from '~/app/services/github-reader';
import { parsePR } from '~/app/services/commit-parser';
import { isReleaseBranch, type ParsedPR } from '@tagline-sh/shared';

// Matches single-repo tags: `v1.2.3`, `v1.2.3-rc.0`, `1.2.3` etc. Tightened
// to require a numeric major to avoid catching arbitrary git tags.
const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+([+-][\w.]+)?$/;

// Matches per-package monorepo tags Changesets-style: `@scope/name@1.2.3`
// (scoped) or `name@1.2.3` (unscoped). Version half must be valid semver so
// we don't accidentally pick up arbitrary `name@something` git tags.
const PACKAGE_TAG_RE = /^(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+([+-][\w.]+)?$/;

/**
 * Newest release tag in the repo, or `null` if none exist.
 *
 * Recognizes both:
 *   - single-repo tags (`v1.2.3`, `1.2.3`)
 *   - per-package monorepo tags (`@scope/name@1.2.3`, `name@1.2.3`)
 *
 * Sort strategy depends on what's present:
 *   - **Only single-repo tags** → semver descending. A back-port tag `v1.0.1`
 *     created after `v2.0.0` is NOT "newer" for release purposes.
 *   - **Only per-package tags, or a mix** → commit date descending. Semver
 *     comparison is meaningless across different package namespaces
 *     (`@acme/api@2.0.0` and `@acme/ui@0.5.0` aren't ordered by version), and
 *     the back-port concern doesn't generalize to per-package versioning
 *     anyway — each package's history is independent.
 *
 * The mixed case matters in practice: a repo that started single-repo and
 * later switched to monorepo (e.g. this one — `v1.0.0` lives alongside
 * `@tagline-sh/bot@0.1.0`) must NOT pick the stale single-repo tag just
 * because it sorts higher under semver. The per-package tags are the live
 * release line; the legacy `v*` tag is history.
 */
export async function getLastReleaseTag(
    reader: GitHubReader,
    repo: RepoRef,
): Promise<TagRef | null> {
    const tags = await reader.listTags(repo);
    const singleRepoTags = tags.filter((t) => SEMVER_TAG_RE.test(t.name));
    const packageTags = tags.filter((t) => PACKAGE_TAG_RE.test(t.name));
    const releaseTags = [...singleRepoTags, ...packageTags];
    if (releaseTags.length === 0) return null;

    if (packageTags.length === 0) {
        // Pure single-repo: semver sort (back-port safe).
        singleRepoTags.sort((a, b) => {
            const av = semver.coerce(a.name)?.version ?? '0.0.0';
            const bv = semver.coerce(b.name)?.version ?? '0.0.0';
            return semver.rcompare(av, bv);
        });
        return singleRepoTags[0] ?? null;
    }

    // Per-package tags present (with or without legacy v* tags): sort by
    // commit date descending and pick the freshest. This matches "what
    // happened most recently in this repo's release history" — the right
    // anchor for "since X" PR filtering.
    releaseTags.sort((a, b) => {
        const at = Date.parse(a.commitDate);
        const bt = Date.parse(b.commitDate);
        if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
        if (Number.isNaN(at)) return 1;
        if (Number.isNaN(bt)) return -1;
        return bt - at;
    });
    return releaseTags[0] ?? null;
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
 *
 * Filters out the bot's own previous release PRs (head ref starts with
 * `release/v…`). The tag for `vN` lives on the *release-branch tip*, which is
 * older than the merge commit that lands the release PR on the production
 * branch — so the previous release PR satisfies `merged > tag.commitDate` and
 * would otherwise become the only "change" picked up next time. Worse, its
 * body is the previous changelog full of `#N` references that get extracted
 * as tickets, producing a single mega-bullet with every prior PR linked.
 */
export async function getPRsSinceLastTag(
    reader: GitHubReader,
    repo: RepoRef,
    branch: string,
): Promise<{ prs: PullRequestSummary[]; lastTag: TagRef | null }> {
    const lastTag = await getLastReleaseTag(reader, repo);
    const since = lastTag?.commitDate ?? null;
    const all = await reader.listMergedPRs(repo, branch, since);
    const prs = all.filter((pr) => !isReleaseBranch(pr.headRef));
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
