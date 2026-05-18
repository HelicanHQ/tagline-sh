import type { Octokit } from 'octokit';
import type {
    CommitRef,
    GitHubReader,
    PullRequestFile,
    PullRequestSummary,
    RepoRef,
    TagRef,
} from './github-reader.js';

/**
 * Minimal Octokit shape this reader needs. Defined as a `Pick` so we accept
 * any Octokit-flavored object — both the bare `octokit` package's Octokit and
 * Probot's `context.octokit` satisfy this (they differ on `.hook` and
 * retry-shim intersection types we never touch).
 */
export type ReaderOctokit = Pick<Octokit, 'rest' | 'paginate'>;

/**
 * `GitHubReader` implementation backed by an authenticated Octokit instance.
 *
 * Phase 4 will inject Probot's `context.octokit` here. For Phase 3 standalone
 * usage, callers construct an `Octokit({ auth })` instance directly.
 *
 * Behaviors worth knowing:
 *   - `getFileContent` returns `null` on 404 (e.g. `.release-agent.md` absent).
 *     Other errors propagate so callers can surface them.
 *   - `listDirectory` returns basenames, never full paths.
 *   - `listMergedPRs` uses the Search API (which is also rate-limited
 *     separately from REST — 30 req/min for authenticated apps).
 */
export class OctokitGitHubReader implements GitHubReader {
    constructor(private readonly octokit: ReaderOctokit) {}

    async getFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null> {
        try {
            const res = await this.octokit.rest.repos.getContent({
                owner: repo.owner,
                repo: repo.repo,
                path,
                ...(ref ? { ref } : {}),
            });
            const data = res.data;
            if (Array.isArray(data) || data.type !== 'file') return null;
            if (!('content' in data) || typeof data.content !== 'string') return null;
            return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString(
                'utf8',
            );
        } catch (err) {
            if (isStatusError(err, 404)) return null;
            throw err;
        }
    }

    async listDirectory(repo: RepoRef, path: string, ref?: string): Promise<string[]> {
        try {
            const res = await this.octokit.rest.repos.getContent({
                owner: repo.owner,
                repo: repo.repo,
                path: path === '.' ? '' : path,
                ...(ref ? { ref } : {}),
            });
            const data = res.data;
            if (!Array.isArray(data)) return [];
            return data.map((entry) => entry.name);
        } catch (err) {
            if (isStatusError(err, 404)) return [];
            throw err;
        }
    }

    async listTags(repo: RepoRef): Promise<TagRef[]> {
        const result: TagRef[] = [];
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listTags, {
            owner: repo.owner,
            repo: repo.repo,
            per_page: 100,
        });
        for await (const { data } of iterator) {
            for (const tag of data) {
                // We need the *commit date* of the tagged commit, not the tag
                // creation date. listTags returns commit.sha; fetch the commit
                // to get its committer date.
                const sha = tag.commit.sha;
                const commit = await this.octokit.rest.git.getCommit({
                    owner: repo.owner,
                    repo: repo.repo,
                    commit_sha: sha,
                });
                result.push({
                    name: tag.name,
                    sha,
                    commitDate: commit.data.committer?.date ?? commit.data.author?.date ?? '',
                });
            }
        }
        return result;
    }

    async getDefaultBranch(repo: RepoRef): Promise<string> {
        const res = await this.octokit.rest.repos.get({
            owner: repo.owner,
            repo: repo.repo,
        });
        return res.data.default_branch;
    }

    async listMergedPRs(
        repo: RepoRef,
        branch: string,
        since: string | null,
    ): Promise<PullRequestSummary[]> {
        const qParts = [
            `repo:${repo.owner}/${repo.repo}`,
            'is:pr',
            'is:merged',
            `base:${branch}`,
        ];
        if (since) qParts.push(`merged:>${since}`);
        const q = qParts.join(' ');

        const summaries: PullRequestSummary[] = [];
        const iterator = this.octokit.paginate.iterator(
            this.octokit.rest.search.issuesAndPullRequests,
            { q, sort: 'created', order: 'asc', per_page: 100 },
        );
        for await (const { data } of iterator) {
            for (const item of data) {
                // The Search API returns issue-shaped objects. We hydrate each
                // into a full PR via pulls.get so we have base/head refs and a
                // real `merged_at`.
                const full = await this.octokit.rest.pulls.get({
                    owner: repo.owner,
                    repo: repo.repo,
                    pull_number: item.number,
                });
                const p = full.data;
                if (!p.merged_at) continue;
                summaries.push({
                    number: p.number,
                    title: p.title,
                    body: p.body ?? null,
                    url: p.html_url,
                    author: p.user?.login ?? 'unknown',
                    mergedAt: p.merged_at,
                    baseRef: p.base.ref,
                    headRef: p.head.ref,
                });
            }
        }
        return summaries;
    }

    async listPRCommits(repo: RepoRef, prNumber: number): Promise<CommitRef[]> {
        const result: CommitRef[] = [];
        const iterator = this.octokit.paginate.iterator(
            this.octokit.rest.pulls.listCommits,
            {
                owner: repo.owner,
                repo: repo.repo,
                pull_number: prNumber,
                per_page: 100,
            },
        );
        for await (const { data } of iterator) {
            for (const c of data) {
                result.push({
                    sha: c.sha,
                    message: c.commit.message,
                    author: c.author?.login ?? null,
                });
            }
        }
        return result;
    }

    async listPRFiles(repo: RepoRef, prNumber: number): Promise<PullRequestFile[]> {
        const result: PullRequestFile[] = [];
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.pulls.listFiles, {
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNumber,
            per_page: 100,
        });
        for await (const { data } of iterator) {
            for (const f of data) result.push({ filename: f.filename });
        }
        return result;
    }
}

function isStatusError(err: unknown, status: number): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        (err as { status?: number }).status === status
    );
}
