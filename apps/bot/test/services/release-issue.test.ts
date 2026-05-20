import { describe, it, expect, vi } from 'vitest';
import type { ParsedPR } from '@tagline-sh/shared';
import {
    RELEASE_ISSUE_LABEL,
    buildClosingCommentBody,
    closeReleaseIssue,
    createReleaseIssue,
    encodeMarker,
    ensureReleaseLabel,
    extractMarker,
    findOpenReleaseIssue,
    renderReleaseIssueBody,
    renderReleaseIssueTitle,
    updateReleaseIssue,
    type ReleaseIssueOctokit,
} from '../../src/services/release-issue.js';

const ANY_REPO = { owner: 'acme', repo: 'widget' };

function fakePR(overrides: Partial<ParsedPR> = {}): ParsedPR {
    return {
        number: 42,
        title: 'feat(api): add OAuth2 PKCE',
        url: 'https://github.com/acme/widget/pull/42',
        author: 'octocat',
        mergedAt: '2026-05-20T10:00:00Z',
        commits: [],
        tickets: [],
        suggestedBump: 'minor',
        bodyExcerpt: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Pure helpers — no Octokit involved
// ---------------------------------------------------------------------------

describe('encodeMarker / extractMarker', () => {
    it('round-trips a marker through encode + extract', () => {
        const original = { v: 1 as const, branch: 'main', lastTag: 'v0.5.0' };
        const encoded = encodeMarker(original);
        expect(encoded).toContain('<!-- tagline-issue-v1');
        expect(encoded).toContain('"main"');
        expect(extractMarker(encoded)).toEqual(original);
    });

    it('extracts a marker embedded in a larger markdown body', () => {
        const body = [
            '## Header',
            '',
            'Some text.',
            '',
            encodeMarker({ v: 1, branch: 'master', lastTag: null }),
        ].join('\n');
        expect(extractMarker(body)).toEqual({ v: 1, branch: 'master', lastTag: null });
    });

    it('returns null for a body with no marker', () => {
        expect(extractMarker('## just a normal issue')).toBeNull();
        expect(extractMarker('')).toBeNull();
        expect(extractMarker(null)).toBeNull();
        expect(extractMarker(undefined)).toBeNull();
    });

    it('returns null for a marker whose JSON is malformed', () => {
        const bad = '<!-- tagline-issue-v1 {not json -->';
        expect(extractMarker(bad)).toBeNull();
    });

    it('returns null for a marker with an unknown schema version', () => {
        const future = '<!-- tagline-issue-v1 {"v":2,"branch":"main"} -->';
        expect(extractMarker(future)).toBeNull();
    });

    it('returns null when the marker is opened but never closed', () => {
        // A truncated body should fail safely rather than parse garbage.
        const truncated = '<!-- tagline-issue-v1 {"v":1,"branch":"main"}';
        expect(extractMarker(truncated)).toBeNull();
    });
});

describe('renderReleaseIssueTitle', () => {
    it('uses singular "change" for 1 PR', () => {
        expect(renderReleaseIssueTitle({ lastTag: 'v1.0.0', prCount: 1 })).toBe(
            '🚀 Release pending — 1 change since v1.0.0',
        );
    });

    it('uses plural "changes" for N PRs', () => {
        expect(renderReleaseIssueTitle({ lastTag: 'v1.0.0', prCount: 5 })).toBe(
            '🚀 Release pending — 5 changes since v1.0.0',
        );
    });

    it('says "since the first release" when lastTag is null (no prior release)', () => {
        expect(renderReleaseIssueTitle({ lastTag: null, prCount: 3 })).toBe(
            '🚀 Release pending — 3 changes since the first release',
        );
    });
});

describe('renderReleaseIssueBody', () => {
    it('lists each PR with humanized title, issue link, and author', () => {
        const body = renderReleaseIssueBody({
            branch: 'main',
            lastTag: 'v0.5.0',
            prs: [
                fakePR({ number: 1, title: 'feat: add login', url: 'u1', author: 'alice' }),
                fakePR({ number: 2, title: 'fix(api): null check', url: 'u2', author: 'bob' }),
            ],
        });
        // Title prefix stripped, link wrapped, author tagged
        expect(body).toContain('- add login ([#1](u1)) — @alice');
        expect(body).toContain('- null check ([#2](u2)) — @bob');
    });

    it('includes the command reference and a "this issue only" footer', () => {
        const body = renderReleaseIssueBody({ branch: 'main', lastTag: null, prs: [fakePR()] });
        expect(body).toContain('/release-report');
        expect(body).toContain('/approve');
        expect(body).toContain('Slash commands only work **on this issue**');
    });

    it('embeds a marker that round-trips through extractMarker', () => {
        const body = renderReleaseIssueBody({
            branch: 'production',
            lastTag: 'v2.1.0',
            prs: [fakePR()],
        });
        const marker = extractMarker(body);
        expect(marker).toEqual({ v: 1, branch: 'production', lastTag: 'v2.1.0' });
    });

    it('falls back to a friendly empty-state when no PRs are pending', () => {
        const body = renderReleaseIssueBody({ branch: 'main', lastTag: 'v1.0.0', prs: [] });
        expect(body).toContain('No PRs merged yet');
    });

    it('falls back to the raw title if a PR title has no conventional-commit prefix', () => {
        const body = renderReleaseIssueBody({
            branch: 'main',
            lastTag: null,
            prs: [fakePR({ title: 'Improved designs', number: 9, url: 'u9', author: 'cat' })],
        });
        expect(body).toContain('- Improved designs ([#9](u9)) — @cat');
    });
});

describe('buildClosingCommentBody', () => {
    it('renders the released tag, link, and Ready-to-share block', () => {
        const body = buildClosingCommentBody({
            issueNumber: 7,
            tagName: 'v1.5.0',
            releaseUrl: 'https://github.com/acme/widget/releases/tag/v1.5.0',
            readyToShareMarkdown:
                "## What's new in v1.5.0\n\nYou can now sign in with Google.\n\n- SSO via Google",
        });
        expect(body).toMatch(/Released `v1\.5\.0` 🎉/);
        expect(body).toContain('https://github.com/acme/widget/releases/tag/v1.5.0');
        expect(body).toContain('**Ready to share:**');
        expect(body).toContain('SSO via Google');
    });
});

// ---------------------------------------------------------------------------
// Octokit-backed operations (fake Octokit per call)
// ---------------------------------------------------------------------------

interface FakeIssuesOptions {
    listForRepoData?: Array<{
        number: number;
        title: string;
        body: string | null;
        state: string;
        pull_request?: unknown;
    }>;
}

function fakeIssuesOctokit(options: FakeIssuesOptions = {}) {
    const calls = {
        listForRepo: vi.fn(async () => ({ data: options.listForRepoData ?? [] })),
        create: vi.fn(async () => ({ data: { number: 99, html_url: 'https://example/issues/99' } })),
        update: vi.fn(async () => ({ data: { number: 99 } })),
        createComment: vi.fn(async () => ({ data: { id: 1, html_url: 'c' } })),
        removeLabel: vi.fn(async () => ({})),
        getLabel: vi.fn(async () => ({ data: { name: RELEASE_ISSUE_LABEL } })),
        createLabel: vi.fn(async () => ({ data: { name: RELEASE_ISSUE_LABEL } })),
    };
    const octokit = {
        rest: {
            issues: {
                listForRepo: calls.listForRepo,
                create: calls.create,
                update: calls.update,
                createComment: calls.createComment,
                removeLabel: calls.removeLabel,
                getLabel: calls.getLabel,
                createLabel: calls.createLabel,
            },
        },
    } as unknown as ReleaseIssueOctokit;
    return { octokit, calls };
}

/**
 * vi.fn's call-arg tuple is inferred as `[]` when the impl has no params,
 * so `mock.calls[N]?.[0]` fails typecheck at indexing. Cast the array first
 * (same workaround as `approve.test.ts`).
 */
function firstCallArg<T>(spy: ReturnType<typeof vi.fn>): T {
    const calls = spy.mock.calls as unknown as Array<[T]>;
    const first = calls[0];
    if (!first) throw new Error('expected spy to have been called');
    return first[0];
}

describe('findOpenReleaseIssue', () => {
    it('returns null when the repo has no labeled open issues', async () => {
        const { octokit } = fakeIssuesOctokit({ listForRepoData: [] });
        expect(await findOpenReleaseIssue(octokit, ANY_REPO)).toBeNull();
    });

    it('returns the labeled issue when its body contains a valid marker', async () => {
        const marker = encodeMarker({ v: 1, branch: 'main', lastTag: 'v0.5.0' });
        const { octokit } = fakeIssuesOctokit({
            listForRepoData: [
                {
                    number: 12,
                    title: 'release pending',
                    body: `body ${marker}`,
                    state: 'open',
                },
            ],
        });
        const result = await findOpenReleaseIssue(octokit, ANY_REPO);
        expect(result?.number).toBe(12);
        expect(result?.marker).toEqual({ v: 1, branch: 'main', lastTag: 'v0.5.0' });
    });

    it('ignores labeled issues whose body does NOT contain a marker (defense against manual label)', async () => {
        // A maintainer added the label by hand to an unrelated issue. The
        // marker absence must disqualify it from being matched as "ours."
        const { octokit } = fakeIssuesOctokit({
            listForRepoData: [
                { number: 5, title: 'unrelated', body: 'no marker here', state: 'open' },
            ],
        });
        expect(await findOpenReleaseIssue(octokit, ANY_REPO)).toBeNull();
    });

    it('skips PRs returned by listForRepo (which mixes issues and PRs)', async () => {
        const marker = encodeMarker({ v: 1, branch: 'main', lastTag: null });
        const { octokit } = fakeIssuesOctokit({
            listForRepoData: [
                // A PR happened to carry the label and the marker text — still
                // not a Tagline release issue. `pull_request` field signals PR-ness.
                {
                    number: 1,
                    title: 'PR',
                    body: marker,
                    state: 'open',
                    pull_request: { url: 'pr-url' },
                },
                { number: 2, title: 'real issue', body: marker, state: 'open' },
            ],
        });
        const result = await findOpenReleaseIssue(octokit, ANY_REPO);
        expect(result?.number).toBe(2);
    });
});

describe('ensureReleaseLabel', () => {
    it('does nothing when the label already exists', async () => {
        const { octokit, calls } = fakeIssuesOctokit();
        await ensureReleaseLabel(octokit, ANY_REPO);
        expect(calls.getLabel).toHaveBeenCalledTimes(1);
        expect(calls.createLabel).not.toHaveBeenCalled();
    });

    it('creates the label on first call (404 → create)', async () => {
        const notFound = Object.assign(new Error('not found'), { status: 404 });
        const { octokit, calls } = fakeIssuesOctokit();
        calls.getLabel.mockRejectedValueOnce(notFound);
        await ensureReleaseLabel(octokit, ANY_REPO);
        expect(calls.createLabel).toHaveBeenCalledTimes(1);
        const args = firstCallArg<{ name: string }>(calls.createLabel);
        expect(args.name).toBe(RELEASE_ISSUE_LABEL);
    });

    it('treats 422 "already exists" on create as success (concurrent-create race)', async () => {
        const notFound = Object.assign(new Error('not found'), { status: 404 });
        const conflict = Object.assign(new Error('already exists'), { status: 422 });
        const { octokit, calls } = fakeIssuesOctokit();
        calls.getLabel.mockRejectedValueOnce(notFound);
        calls.createLabel.mockRejectedValueOnce(conflict);
        await expect(ensureReleaseLabel(octokit, ANY_REPO)).resolves.toBeUndefined();
        expect(calls.createLabel).toHaveBeenCalledTimes(1);
    });
});

describe('createReleaseIssue', () => {
    it('creates the label (idempotent), then creates an issue with the rendered title/body/label', async () => {
        const { octokit, calls } = fakeIssuesOctokit();
        const result = await createReleaseIssue(octokit, ANY_REPO, {
            branch: 'main',
            lastTag: 'v1.0.0',
            prs: [fakePR()],
        });
        expect(result.number).toBe(99);
        expect(calls.create).toHaveBeenCalledTimes(1);
        const args = firstCallArg<{ title: string; body: string; labels: string[] }>(
            calls.create,
        );
        expect(args.title).toContain('Release pending');
        expect(args.body).toContain('<!-- tagline-issue-v1');
        expect(args.labels).toEqual([RELEASE_ISSUE_LABEL]);
    });
});

describe('updateReleaseIssue', () => {
    it('rewrites the title and body from scratch (idempotent re-render)', async () => {
        const { octokit, calls } = fakeIssuesOctokit();
        await updateReleaseIssue(octokit, ANY_REPO, {
            issueNumber: 7,
            branch: 'main',
            lastTag: 'v1.0.0',
            prs: [fakePR({ number: 1 }), fakePR({ number: 2 })],
        });
        expect(calls.update).toHaveBeenCalledTimes(1);
        const args = firstCallArg<{ issue_number: number; title: string; body: string }>(
            calls.update,
        );
        expect(args.issue_number).toBe(7);
        expect(args.title).toContain('2 changes');
        expect(args.body).toContain('#1');
        expect(args.body).toContain('#2');
    });
});

describe('closeReleaseIssue', () => {
    it('comments, removes the label, and closes the issue (in that order)', async () => {
        const { octokit, calls } = fakeIssuesOctokit();
        await closeReleaseIssue(octokit, ANY_REPO, {
            issueNumber: 7,
            tagName: 'v1.5.0',
            releaseUrl: 'https://github.com/acme/widget/releases/tag/v1.5.0',
            readyToShareMarkdown: '## v1.5.0\n\nGood stuff.',
        });
        expect(calls.createComment).toHaveBeenCalledTimes(1);
        expect(calls.removeLabel).toHaveBeenCalledTimes(1);
        expect(calls.update).toHaveBeenCalledTimes(1);

        // Order: comment → remove label → close. Verify via call invocation order.
        const commentOrder = calls.createComment.mock.invocationCallOrder[0]!;
        const removeOrder = calls.removeLabel.mock.invocationCallOrder[0]!;
        const updateOrder = calls.update.mock.invocationCallOrder[0]!;
        expect(commentOrder).toBeLessThan(removeOrder);
        expect(removeOrder).toBeLessThan(updateOrder);

        // The close call sets state: 'closed'
        const closeArgs = firstCallArg<{ state?: string }>(calls.update);
        expect(closeArgs.state).toBe('closed');
    });

    it('swallows 404 on label removal (idempotent re-close)', async () => {
        const notFound = Object.assign(new Error('not found'), { status: 404 });
        const { octokit, calls } = fakeIssuesOctokit();
        calls.removeLabel.mockRejectedValueOnce(notFound);
        await expect(
            closeReleaseIssue(octokit, ANY_REPO, {
                issueNumber: 7,
                tagName: 'v1.5.0',
                releaseUrl: 'r',
                readyToShareMarkdown: 's',
            }),
        ).resolves.toBeUndefined();
        // The close still happens despite the label-removal 404.
        expect(calls.update).toHaveBeenCalledTimes(1);
    });

    it('does NOT swallow non-404 errors on label removal (e.g. 500)', async () => {
        const serverError = Object.assign(new Error('boom'), { status: 500 });
        const { octokit, calls } = fakeIssuesOctokit();
        calls.removeLabel.mockRejectedValueOnce(serverError);
        await expect(
            closeReleaseIssue(octokit, ANY_REPO, {
                issueNumber: 7,
                tagName: 'v1.5.0',
                releaseUrl: 'r',
                readyToShareMarkdown: 's',
            }),
        ).rejects.toThrow('boom');
    });
});
