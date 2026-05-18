import type {
    CommitRef,
    GitHubReader,
    PullRequestFile,
    PullRequestSummary,
    RepoRef,
    TagRef,
} from '../../src/services/github-reader.js';

export interface FakeRepoState {
    /** Map of path → file content. Paths are repo-relative, no leading slash. */
    files?: Record<string, string>;
    /** Map of directory path → child basenames. Use `.` for the repo root. */
    directories?: Record<string, string[]>;
    tags?: TagRef[];
    defaultBranch?: string;
    mergedPRs?: PullRequestSummary[];
    /** Map of PR number → commits. */
    prCommits?: Record<number, CommitRef[]>;
    /** Map of PR number → files changed. */
    prFiles?: Record<number, PullRequestFile[]>;
}

/**
 * A trivial in-memory `GitHubReader` for unit tests. Doesn't model branches
 * separately — the `ref` argument is ignored. Sufficient for the pure-service
 * tests where we just want to feed canned responses.
 */
export class FakeGitHubReader implements GitHubReader {
    constructor(private state: FakeRepoState) {}

    async getFileContent(_repo: RepoRef, path: string): Promise<string | null> {
        return this.state.files?.[path] ?? null;
    }

    async listDirectory(_repo: RepoRef, path: string): Promise<string[]> {
        return this.state.directories?.[path] ?? [];
    }

    async listTags(_repo: RepoRef): Promise<TagRef[]> {
        return this.state.tags ?? [];
    }

    async getDefaultBranch(_repo: RepoRef): Promise<string> {
        return this.state.defaultBranch ?? 'main';
    }

    async listMergedPRs(
        _repo: RepoRef,
        branch: string,
        since: string | null,
    ): Promise<PullRequestSummary[]> {
        const all = this.state.mergedPRs ?? [];
        return all.filter((pr) => {
            if (pr.baseRef !== branch) return false;
            if (since && pr.mergedAt <= since) return false;
            return true;
        });
    }

    async listPRCommits(_repo: RepoRef, prNumber: number): Promise<CommitRef[]> {
        return this.state.prCommits?.[prNumber] ?? [];
    }

    async listPRFiles(_repo: RepoRef, prNumber: number): Promise<PullRequestFile[]> {
        return this.state.prFiles?.[prNumber] ?? [];
    }
}

export const ANY_REPO: RepoRef = { owner: 'acme', repo: 'widget' };
