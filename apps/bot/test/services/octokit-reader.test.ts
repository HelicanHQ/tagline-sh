import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from 'octokit';
import { OctokitGitHubReader } from '../../src/services/octokit-reader.js';

// We can't run real HTTP in unit tests. Instead, we synthesize a structural
// subset of Octokit that only implements the methods our reader actually calls.
// Each test installs the responses it needs and asserts on the request shape.

interface RequestError extends Error {
    status: number;
}

function notFound(): RequestError {
    const err = new Error('404') as RequestError;
    err.status = 404;
    return err;
}

function buildOctokit(overrides: {
    repos?: Partial<Octokit['rest']['repos']>;
    git?: Partial<Octokit['rest']['git']>;
    search?: Partial<Octokit['rest']['search']>;
    pulls?: Partial<Octokit['rest']['pulls']>;
    paginate?: unknown;
}): Octokit {
    return {
        rest: {
            repos: overrides.repos ?? {},
            git: overrides.git ?? {},
            search: overrides.search ?? {},
            pulls: overrides.pulls ?? {},
        },
        paginate: overrides.paginate ?? {
            iterator: vi.fn(async function* () {
                yield { data: [] };
            }),
        },
    } as unknown as Octokit;
}

const REPO = { owner: 'acme', repo: 'widget' };

describe('OctokitGitHubReader.getFileContent', () => {
    it('decodes a base64 file response to UTF-8', async () => {
        const content = Buffer.from('hello world', 'utf8').toString('base64');
        const octokit = buildOctokit({
            repos: {
                getContent: vi.fn(async () => ({
                    data: { type: 'file', encoding: 'base64', content },
                    status: 200,
                    headers: {},
                    url: '',
                })) as unknown as Octokit['rest']['repos']['getContent'],
            },
        });
        const reader = new OctokitGitHubReader(octokit);
        expect(await reader.getFileContent(REPO, 'README.md')).toBe('hello world');
    });

    it('returns null on 404', async () => {
        const octokit = buildOctokit({
            repos: {
                getContent: vi.fn(async () => {
                    throw notFound();
                }) as unknown as Octokit['rest']['repos']['getContent'],
            },
        });
        const reader = new OctokitGitHubReader(octokit);
        expect(await reader.getFileContent(REPO, '.release-agent.md')).toBeNull();
    });

    it('returns null when the path resolves to a directory', async () => {
        const octokit = buildOctokit({
            repos: {
                getContent: vi.fn(async () => ({
                    data: [{ name: 'foo' }, { name: 'bar' }],
                    status: 200,
                    headers: {},
                    url: '',
                })) as unknown as Octokit['rest']['repos']['getContent'],
            },
        });
        const reader = new OctokitGitHubReader(octokit);
        expect(await reader.getFileContent(REPO, 'src')).toBeNull();
    });

    it('re-throws non-404 errors', async () => {
        const err = new Error('500 server') as RequestError;
        err.status = 500;
        const octokit = buildOctokit({
            repos: {
                getContent: vi.fn(async () => {
                    throw err;
                }) as unknown as Octokit['rest']['repos']['getContent'],
            },
        });
        const reader = new OctokitGitHubReader(octokit);
        await expect(reader.getFileContent(REPO, 'x')).rejects.toThrow('500 server');
    });
});

describe('OctokitGitHubReader.listDirectory', () => {
    it('returns child basenames for a directory', async () => {
        const octokit = buildOctokit({
            repos: {
                getContent: vi.fn(async () => ({
                    data: [{ name: 'api' }, { name: 'ui' }],
                    status: 200,
                    headers: {},
                    url: '',
                })) as unknown as Octokit['rest']['repos']['getContent'],
            },
        });
        const reader = new OctokitGitHubReader(octokit);
        expect(await reader.listDirectory(REPO, 'packages')).toEqual(['api', 'ui']);
    });

    it('returns [] on 404', async () => {
        const octokit = buildOctokit({
            repos: {
                getContent: vi.fn(async () => {
                    throw notFound();
                }) as unknown as Octokit['rest']['repos']['getContent'],
            },
        });
        const reader = new OctokitGitHubReader(octokit);
        expect(await reader.listDirectory(REPO, 'nonexistent')).toEqual([]);
    });
});

describe('OctokitGitHubReader.listMergedPRs', () => {
    it('builds the correct Search query and hydrates via pulls.get', async () => {
        const searchCalls: Array<Record<string, unknown>> = [];
        const iterator = vi.fn(async function* (_method: unknown, params: Record<string, unknown>) {
            searchCalls.push(params);
            yield { data: [{ number: 42 }] };
        });
        const pullsGet = vi.fn(async () => ({
            data: {
                number: 42,
                title: 'feat: thing',
                body: 'b',
                html_url: 'https://gh/pr/42',
                user: { login: 'octocat' },
                merged_at: '2026-02-01T00:00:00Z',
                base: { ref: 'main' },
                head: { ref: 'feature/x' },
            },
            status: 200,
            headers: {},
            url: '',
        }));

        const octokit = buildOctokit({
            search: { issuesAndPullRequests: vi.fn() as unknown as Octokit['rest']['search']['issuesAndPullRequests'] },
            pulls: { get: pullsGet as unknown as Octokit['rest']['pulls']['get'] },
            paginate: { iterator },
        });

        const reader = new OctokitGitHubReader(octokit);
        const prs = await reader.listMergedPRs(REPO, 'main', '2026-01-01T00:00:00Z');

        expect(prs).toHaveLength(1);
        expect(prs[0]?.number).toBe(42);
        expect(prs[0]?.baseRef).toBe('main');
        expect(prs[0]?.author).toBe('octocat');

        const q = searchCalls[0]?.['q'] as string;
        expect(q).toContain('repo:acme/widget');
        expect(q).toContain('is:pr');
        expect(q).toContain('is:merged');
        expect(q).toContain('base:main');
        expect(q).toContain('merged:>2026-01-01T00:00:00Z');
    });

    it('omits merged:> when since is null (first-release case)', async () => {
        const searchCalls: Array<Record<string, unknown>> = [];
        const iterator = vi.fn(async function* (_method: unknown, params: Record<string, unknown>) {
            searchCalls.push(params);
            yield { data: [] };
        });
        const octokit = buildOctokit({
            search: { issuesAndPullRequests: vi.fn() as unknown as Octokit['rest']['search']['issuesAndPullRequests'] },
            paginate: { iterator },
        });

        const reader = new OctokitGitHubReader(octokit);
        await reader.listMergedPRs(REPO, 'main', null);
        expect(searchCalls[0]?.['q']).not.toContain('merged:>');
    });
});
