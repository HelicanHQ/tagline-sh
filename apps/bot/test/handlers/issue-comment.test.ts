import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'probot';
import { handleIssueComment } from '../../src/handlers/issue-comment.js';
import { RELEASE_ISSUE_LABEL, encodeMarker } from '../../src/services/release-issue.js';

// We don't pull in Probot's testing helpers — they require nock + a built
// app. Instead we hand-craft just enough Context shape for the handler's
// flow (it touches `payload`, `octokit`, `repo()`, `log.error`).

interface FakeOctokitCalls {
    createComment: ReturnType<typeof vi.fn>;
    updateComment: ReturnType<typeof vi.fn>;
    getPerm: ReturnType<typeof vi.fn>;
}

/**
 * By default `makeContext` sets up a release-tracking issue venue (the label
 * is attached AND the body carries the v1 marker). Tests can override `issue`
 * to verify the venue gate rejects non-release-issue surfaces.
 */
function makeContext(opts: {
    body: string;
    senderType?: 'User' | 'Bot';
    senderLogin?: string;
    permission?: string;
    issue?: {
        number?: number;
        body?: string | null;
        labels?: Array<{ name: string } | string>;
        pull_request?: unknown;
    };
}): { context: Context<'issue_comment.created'>; calls: FakeOctokitCalls } {
    const calls: FakeOctokitCalls = {
        createComment: vi.fn(async () => ({ data: { id: 9001 } })),
        updateComment: vi.fn(async () => ({ data: {} })),
        getPerm: vi.fn(async () => ({
            data: { permission: opts.permission ?? 'write' },
        })),
    };

    const defaultMarker = encodeMarker({ v: 1, branch: 'main', lastTag: 'v0.5.0' });
    const issue = opts.issue ?? {};
    const ctx = {
        payload: {
            action: 'created',
            comment: { body: opts.body, id: 1 },
            issue: {
                number: issue.number ?? 7,
                body: issue.body !== undefined ? issue.body : defaultMarker,
                labels: issue.labels ?? [{ name: RELEASE_ISSUE_LABEL }],
                ...(issue.pull_request ? { pull_request: issue.pull_request } : {}),
            },
            sender: { login: opts.senderLogin ?? 'octocat', type: opts.senderType ?? 'User' },
        },
        repo: () => ({ owner: 'acme', repo: 'widget' }),
        log: {
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        },
        octokit: {
            rest: {
                issues: {
                    createComment: calls.createComment,
                    updateComment: calls.updateComment,
                },
                repos: {
                    getCollaboratorPermissionLevel: calls.getPerm,
                },
            },
        },
    } as unknown as Context<'issue_comment.created'>;
    return { context: ctx, calls };
}

describe('handleIssueComment', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('ignores comments from bots', async () => {
        const { context, calls } = makeContext({
            body: '/release-report',
            senderType: 'Bot',
        });
        await handleIssueComment(context);
        expect(calls.createComment).not.toHaveBeenCalled();
    });

    it('ignores non-slash comments', async () => {
        const { context, calls } = makeContext({ body: 'just a regular comment' });
        await handleIssueComment(context);
        expect(calls.createComment).not.toHaveBeenCalled();
        expect(calls.getPerm).not.toHaveBeenCalled();
    });

    it('posts a noPermissionComment when the actor lacks write', async () => {
        const { context, calls } = makeContext({
            body: '/release-report',
            senderLogin: 'rando',
            permission: 'read',
        });
        await handleIssueComment(context);
        expect(calls.createComment).toHaveBeenCalledTimes(1);
        const firstCall = calls.createComment.mock.calls[0]?.[0] as { body: string };
        expect(firstCall.body).toContain('@rando');
        expect(firstCall.body).toContain('write access');
    });

    it('rejects unparseable /approve args with a usage message', async () => {
        const { context, calls } = makeContext({ body: '/approve nonsense' });
        await handleIssueComment(context);
        expect(calls.createComment).toHaveBeenCalledTimes(1);
        const body = calls.createComment.mock.calls[0]?.[0] as { body: string };
        expect(body.body).toMatch(/didn['’]t understand/);
    });

    it('stays silent on unknown slash commands', async () => {
        const { context, calls } = makeContext({ body: '/lgtm' });
        await handleIssueComment(context);
        expect(calls.createComment).not.toHaveBeenCalled();
    });
});

/**
 * Venue gate (v0.2): commands are processed only on the bot-managed release
 * issue, identified by BOTH the `tagline:release-pending` label AND a v1
 * marker in the body. Either alone is insufficient.
 */
describe('handleIssueComment — venue gate', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('ignores commands on an issue with neither the label nor the marker', async () => {
        const { context, calls } = makeContext({
            body: '/release-report',
            issue: { body: 'just a regular issue', labels: [] },
        });
        await handleIssueComment(context);
        // No comment, no permission check — we bailed at the venue gate.
        expect(calls.createComment).not.toHaveBeenCalled();
        expect(calls.getPerm).not.toHaveBeenCalled();
    });

    it('ignores commands on an issue with the marker but missing the label', async () => {
        // Someone could paste the marker into a random issue body. Without the
        // label, it's still not a Tagline-managed venue.
        const marker = encodeMarker({ v: 1, branch: 'main', lastTag: null });
        const { context, calls } = makeContext({
            body: '/release-report',
            issue: { body: `something ${marker}`, labels: [] },
        });
        await handleIssueComment(context);
        expect(calls.createComment).not.toHaveBeenCalled();
        expect(calls.getPerm).not.toHaveBeenCalled();
    });

    it('ignores commands on an issue with the label but missing the marker', async () => {
        // Conversely, a maintainer could attach the label to an unrelated
        // issue. Without the marker, it's not the bot-managed venue.
        const { context, calls } = makeContext({
            body: '/release-report',
            issue: { body: 'no marker here', labels: [{ name: RELEASE_ISSUE_LABEL }] },
        });
        await handleIssueComment(context);
        expect(calls.createComment).not.toHaveBeenCalled();
    });

    it('ignores commands on PR comments even if a release-issue marker is in the PR body', async () => {
        // PRs are never the release-tracking issue, regardless of body content.
        const marker = encodeMarker({ v: 1, branch: 'main', lastTag: null });
        const { context, calls } = makeContext({
            body: '/release-report',
            issue: {
                body: marker,
                labels: [{ name: RELEASE_ISSUE_LABEL }],
                pull_request: { url: 'pr-url' },
            },
        });
        await handleIssueComment(context);
        expect(calls.createComment).not.toHaveBeenCalled();
    });

    it('accepts the label as a plain-string entry (webhook payload variation)', async () => {
        // GitHub's webhook payloads have shipped labels as both `{name: ...}`
        // objects AND bare strings in different versions. The gate accepts both.
        const marker = encodeMarker({ v: 1, branch: 'main', lastTag: null });
        const { context, calls } = makeContext({
            body: '/lgtm', // unknown command; we just want to confirm we PASSED the gate
            issue: { body: marker, labels: [RELEASE_ISSUE_LABEL] },
        });
        await handleIssueComment(context);
        // We passed the gate; permission check ran (and would have succeeded
        // for 'write'); but the unknown command was silently skipped.
        expect(calls.getPerm).toHaveBeenCalledTimes(1);
        expect(calls.createComment).not.toHaveBeenCalled();
    });
});
