import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'probot';
import { handleIssueComment } from '../../src/handlers/issue-comment.js';

// We don't pull in Probot's testing helpers — they require nock + a built
// app. Instead we hand-craft just enough Context shape for the handler's
// flow (it touches `payload`, `octokit`, `repo()`, `log.error`).

interface FakeOctokitCalls {
    createComment: ReturnType<typeof vi.fn>;
    updateComment: ReturnType<typeof vi.fn>;
    getPerm: ReturnType<typeof vi.fn>;
}

function makeContext(opts: {
    body: string;
    senderType?: 'User' | 'Bot';
    senderLogin?: string;
    permission?: string;
}): { context: Context<'issue_comment.created'>; calls: FakeOctokitCalls } {
    const calls: FakeOctokitCalls = {
        createComment: vi.fn(async () => ({ data: { id: 9001 } })),
        updateComment: vi.fn(async () => ({ data: {} })),
        getPerm: vi.fn(async () => ({
            data: { permission: opts.permission ?? 'write' },
        })),
    };
    const ctx = {
        payload: {
            action: 'created',
            comment: { body: opts.body, id: 1 },
            issue: { number: 7 },
            sender: { login: opts.senderLogin ?? 'octocat', type: opts.senderType ?? 'User' },
        },
        repo: () => ({ owner: 'acme', repo: 'widget' }),
        log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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
