// A minimal GitHub read abstraction. The bot's pure services depend on this
// interface (not on Octokit directly) so they can be unit-tested with in-memory
// fakes. Phase 3 plugs the real Octokit implementation in.

export interface RepoRef {
    owner: string;
    repo: string;
}

export interface TagRef {
    name: string;
    sha: string;
    /** ISO timestamp of the tagged commit (not the tag itself). */
    commitDate: string;
}

export interface CommitRef {
    sha: string;
    message: string;
    /** Login of the commit author, when GitHub knows it. */
    author: string | null;
}

export interface PullRequestSummary {
    number: number;
    title: string;
    body: string | null;
    url: string;
    author: string;
    mergedAt: string; // ISO timestamp
    baseRef: string;
    headRef: string;
}

export interface PullRequestFile {
    /** Path relative to repo root, e.g. `packages/api/src/auth.ts`. */
    filename: string;
}

/**
 * Read-only contract over the GitHub API surface the bot uses.
 *
 * All methods MUST return `null` for missing-file 404s rather than throwing —
 * many services (config-reader, monorepo-detector) treat "absent" as a normal
 * outcome, not an error.
 */
export interface GitHubReader {
    /** Fetch a UTF-8 file at `path` on the given ref. Returns `null` on 404. */
    getFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null>;

    /**
     * List immediate children of a directory at `path` on the given ref.
     * Returns the basenames (not full paths). Returns `[]` if `path` does not exist.
     */
    listDirectory(repo: RepoRef, path: string, ref?: string): Promise<string[]>;

    /** List all release tags. Phase 3 will paginate. */
    listTags(repo: RepoRef): Promise<TagRef[]>;

    /** Default branch of the repo, used as a fallback when no branch is specified. */
    getDefaultBranch(repo: RepoRef): Promise<string>;

    /** List merged PRs targeting `branch` with `merged_at > since` (ISO). */
    listMergedPRs(
        repo: RepoRef,
        branch: string,
        since: string | null,
    ): Promise<PullRequestSummary[]>;

    /** Commits in a PR, ordered oldest→newest. */
    listPRCommits(repo: RepoRef, prNumber: number): Promise<CommitRef[]>;

    /** Files changed in a PR. */
    listPRFiles(repo: RepoRef, prNumber: number): Promise<PullRequestFile[]>;
}
