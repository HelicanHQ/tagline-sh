import { describe, it, expect, vi } from 'vitest';
import type { ParsedPR } from '@tagline-sh/shared';
import { DEFAULT_CONFIG } from '@tagline-sh/shared';
import {
    deterministicReport,
    generateReport,
    type AIClientOptions,
} from '../../src/services/report-generator.js';

const prs: ParsedPR[] = [
    {
        number: 1,
        title: 'feat: thing',
        url: 'u',
        author: 'oct',
        mergedAt: 't',
        commits: [
            {
                type: 'feat',
                scope: null,
                subject: 'thing',
                body: null,
                isBreaking: false,
                sha: 'a',
            },
        ],
        tickets: ['#42'],
        suggestedBump: 'minor',
        bodyExcerpt: 'Adds a thing.',
    },
];

// Pin "now" so summary `date` strings are deterministic across runs.
const FIXED_NOW = new Date(Date.UTC(2026, 4, 18, 12, 0, 0)); // 2026-05-18

const input = {
    prs,
    suggestedBump: 'minor',
    suggestedVersion: '1.5.0',
    config: DEFAULT_CONFIG,
    now: FIXED_NOW,
};

describe('deterministicReport', () => {
    it('returns a fallback reasoning and a changelog rendered from PRs', () => {
        const out = deterministicReport(input);
        expect(out.aiUsed).toBe(false);
        expect(out.reasoning).toContain('AI unavailable');
        expect(out.changelogPreview).toContain('## [1.5.0]');
        expect(out.changelogPreview).toContain('### Added');
        expect(out.changelogPreview).toContain('thing ([#1]');
    });

    it('returns a minimal but valid ReleaseSummary in fallback', () => {
        const out = deterministicReport(input);
        expect(out.summary.version).toBe('1.5.0');
        expect(out.summary.date).toBe('May 18, 2026');
        expect(out.summary.headline).toContain('v1.5.0');
        expect(out.summary.body.length).toBeGreaterThan(0);
        // schema requires 1-5 highlights, never empty
        expect(out.summary.highlights.length).toBeGreaterThanOrEqual(1);
        expect(out.summary.highlights.length).toBeLessThanOrEqual(5);
        // rawMarkdown is fully built and references the version
        expect(out.summary.rawMarkdown).toContain('v1.5.0');
        expect(out.summary.rawMarkdown).toContain('May 18, 2026');
    });

    it('fallback summary takes the first PR title when there are no feat/fix PRs', () => {
        const choreOnly = [
            {
                ...prs[0]!,
                title: 'chore: bump deps',
                commits: [
                    {
                        type: 'chore' as const,
                        scope: null,
                        subject: 'bump deps',
                        body: null,
                        isBreaking: false,
                        sha: 'b',
                    },
                ],
                suggestedBump: 'none' as const,
            },
        ];
        const out = deterministicReport({ ...input, prs: choreOnly });
        expect(out.summary.highlights).toContain('chore: bump deps');
    });
});

interface FakeCompletion {
    choices: Array<{ message: { content: string } }>;
}

function fakeOpenAI(reply: string | Error): AIClientOptions['client'] {
    const create = vi.fn(async (): Promise<FakeCompletion> => {
        if (reply instanceof Error) throw reply;
        return { choices: [{ message: { content: reply } }] };
    });
    return { chat: { completions: { create } } } as unknown as AIClientOptions['client'];
}

/**
 * Variant of `fakeOpenAI` that returns the `create` spy alongside the client so
 * tests can inspect the exact request payload that was sent (model, messages,
 * etc.). Used by the prompt-content tests below — see the "AI is hallucinating
 * because we only send commit TYPES" bug fix.
 */
function fakeOpenAIWithSpy(reply: string): {
    client: AIClientOptions['client'];
    create: ReturnType<typeof vi.fn>;
} {
    const create = vi.fn(async (): Promise<FakeCompletion> => {
        return { choices: [{ message: { content: reply } }] };
    });
    const client = {
        chat: { completions: { create } },
    } as unknown as AIClientOptions['client'];
    return { client, create };
}

function lastPromptSentTo(create: ReturnType<typeof vi.fn>): string {
    const call = create.mock.calls[0] as
        | [{ messages: Array<{ role: string; content: string }> }]
        | undefined;
    if (!call) throw new Error('create was not called');
    const messages = call[0].messages;
    // role: 'user' carries the prompt body we built; system role carries the
    // persona prompt and is asserted separately when needed.
    const userMessage = messages.find((m) => m.role === 'user');
    if (!userMessage) throw new Error('no user message');
    return userMessage.content;
}

const MINIMAL_AI_REPLY = JSON.stringify({
    reasoning: 'r',
    changelogPreview: 'c',
    releaseSummary: { headline: 'h', body: 'b', highlights: ['x'] },
});

describe('generateReport', () => {
    it('returns the AI-supplied reasoning, changelog, AND summary when the call succeeds', async () => {
        const client = fakeOpenAI(
            JSON.stringify({
                reasoning: 'Two new features qualify this as a minor release.',
                changelogPreview: '## [1.5.0] - 2026-05-18\n\n### Added\n\n- AI-generated\n',
                releaseSummary: {
                    headline: 'You can now do the thing.',
                    body: 'A small but meaningful update. Existing flows still work.',
                    highlights: ['Do the thing', 'Better performance'],
                },
            }),
        );
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        expect(out.aiUsed).toBe(true);
        expect(out.reasoning).toContain('Two new features');
        expect(out.changelogPreview).toContain('AI-generated');
        expect(out.summary.headline).toBe('You can now do the thing.');
        expect(out.summary.highlights).toEqual(['Do the thing', 'Better performance']);
        // Version + date filled in by our code, not the AI.
        expect(out.summary.version).toBe('1.5.0');
        expect(out.summary.date).toBe('May 18, 2026');
        expect(out.summary.rawMarkdown).toContain('You can now do the thing.');
        expect(out.summary.rawMarkdown).toContain('- Do the thing');
    });

    it('falls back to the deterministic summary when AI summary is malformed (partial success)', async () => {
        const client = fakeOpenAI(
            JSON.stringify({
                reasoning: 'Two new features qualify this as a minor release.',
                changelogPreview: '## [1.5.0] - 2026-05-18\n\n### Added\n\n- AI-generated\n',
                releaseSummary: { headline: '', body: '', highlights: [] }, // empty everything
            }),
        );
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        // AI text wins for reasoning + changelog
        expect(out.reasoning).toContain('Two new features');
        expect(out.changelogPreview).toContain('AI-generated');
        // But the summary fell back to deterministic
        expect(out.summary.headline).toContain('v1.5.0');
        expect(out.summary.body).toContain('changelog');
        expect(out.aiUsed).toBe(true); // still counts as AI-used overall
    });

    it('truncates AI summary highlights to 5', async () => {
        const client = fakeOpenAI(
            JSON.stringify({
                reasoning: 'r',
                changelogPreview: 'c',
                releaseSummary: {
                    headline: 'h',
                    body: 'b',
                    highlights: ['1', '2', '3', '4', '5', '6', '7'],
                },
            }),
        );
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        expect(out.summary.highlights).toEqual(['1', '2', '3', '4', '5']);
    });

    it('falls back deterministically when the AI throws', async () => {
        const client = fakeOpenAI(new Error('429 rate limited'));
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        expect(out.aiUsed).toBe(false);
        expect(out.reasoning).toContain('AI unavailable');
        // Summary still produced via deterministic fallback
        expect(out.summary.headline).toContain('v1.5.0');
    });

    it('falls back deterministically when the AI returns invalid JSON', async () => {
        const client = fakeOpenAI('not json at all');
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        expect(out.aiUsed).toBe(false);
    });

    it('falls back when the AI returns JSON without required fields', async () => {
        const client = fakeOpenAI(JSON.stringify({ foo: 'bar' }));
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        expect(out.aiUsed).toBe(false);
    });
});

/**
 * Regression suite for the "AI hallucinates because we only feed it commit
 * TYPES" bug. The previous prompt format emitted `Type: feat, feat, fix` for
 * a PR and threw away every commit subject, scope, body, and breaking marker
 * — leaving the AI with nothing but the PR title to base release notes on.
 *
 * These tests assert that the conventional-commit messages collected by
 * `pr-reader` actually reach the AI prompt verbatim.
 */
describe('generateReport — prompt content (commit-message surfacing)', () => {
    const richPRs: ParsedPR[] = [
        {
            number: 19,
            title: 'feat: improved designs',
            url: 'u',
            author: 'moeen',
            mergedAt: 't',
            commits: [
                {
                    type: 'feat',
                    scope: null,
                    subject: 'add dark mode toggle to settings panel',
                    body: null,
                    isBreaking: false,
                    sha: 'a1b2c3d',
                },
                {
                    type: 'feat',
                    scope: 'theme',
                    subject: 'keyboard shortcut for theme switch',
                    body: null,
                    isBreaking: false,
                    sha: 'b2c3d4e',
                },
                {
                    type: 'fix',
                    scope: null,
                    subject: 'dark mode flicker on first paint',
                    body: null,
                    isBreaking: false,
                    sha: 'c3d4e5f',
                },
                {
                    type: 'feat',
                    scope: 'api',
                    subject: 'drop deprecated /v1/users endpoint',
                    body: null,
                    isBreaking: true,
                    sha: 'd4e5f6a',
                },
            ],
            tickets: ['PROJ-42'],
            suggestedBump: 'major',
            bodyExcerpt: 'Multi-PR redesign covering dark mode + API cleanup.',
        },
    ];

    const richInput = {
        prs: richPRs,
        suggestedBump: 'major',
        suggestedVersion: '2.0.0',
        config: DEFAULT_CONFIG,
        now: FIXED_NOW,
    };

    it('surfaces every commit subject of every PR in the user prompt', async () => {
        const { client, create } = fakeOpenAIWithSpy(MINIMAL_AI_REPLY);
        await generateReport(richInput, { apiKey: 'sk-test', client });
        const prompt = lastPromptSentTo(create);

        expect(prompt).toContain('add dark mode toggle to settings panel');
        expect(prompt).toContain('keyboard shortcut for theme switch');
        expect(prompt).toContain('dark mode flicker on first paint');
        expect(prompt).toContain('drop deprecated /v1/users endpoint');
    });

    it('renders scope and the breaking marker so the model can reason about scope/severity', async () => {
        const { client, create } = fakeOpenAIWithSpy(MINIMAL_AI_REPLY);
        await generateReport(richInput, { apiKey: 'sk-test', client });
        const prompt = lastPromptSentTo(create);

        // scope wrapped in parens, conventional-commit style
        expect(prompt).toContain('feat(theme): keyboard shortcut for theme switch');
        // bang marks the breaking change
        expect(prompt).toContain('feat(api)!: drop deprecated /v1/users endpoint');
        // and a non-scoped, non-breaking commit is rendered without parens/bang
        expect(prompt).toContain('feat: add dark mode toggle to settings panel');
    });

    it('still includes PR title and ticket refs alongside the commit list', async () => {
        const { client, create } = fakeOpenAIWithSpy(MINIMAL_AI_REPLY);
        await generateReport(richInput, { apiKey: 'sk-test', client });
        const prompt = lastPromptSentTo(create);

        expect(prompt).toContain('PR #19: feat: improved designs (by @moeen)');
        expect(prompt).toContain('Tickets: PROJ-42');
        expect(prompt).toContain('Commits:');
    });

    it('caps per-PR commit output and emits an overflow line at >15 commits', async () => {
        const manyCommits: ParsedPR[] = [
            {
                ...richPRs[0]!,
                commits: Array.from({ length: 22 }).map((_, i) => ({
                    type: 'feat' as const,
                    scope: null,
                    subject: `commit number ${i + 1}`,
                    body: null,
                    isBreaking: false,
                    sha: `sha${i}`,
                })),
            },
        ];
        const { client, create } = fakeOpenAIWithSpy(MINIMAL_AI_REPLY);
        await generateReport(
            { ...richInput, prs: manyCommits },
            { apiKey: 'sk-test', client },
        );
        const prompt = lastPromptSentTo(create);

        // First 15 commits visible
        expect(prompt).toContain('commit number 1');
        expect(prompt).toContain('commit number 15');
        // 16+ omitted by the cap
        expect(prompt).not.toContain('commit number 16');
        // Overflow line tells the AI explicitly that more exists
        expect(prompt).toContain('(+ 7 more commit(s) omitted)');
    });

    it('drops the old single `Type:` summary line in favor of per-commit lines', async () => {
        const { client, create } = fakeOpenAIWithSpy(MINIMAL_AI_REPLY);
        await generateReport(richInput, { apiKey: 'sk-test', client });
        const prompt = lastPromptSentTo(create);

        // Previously: "Type: feat, feat, fix" — must not be present anymore.
        // Be precise: the substring "Type:" should not appear in the prompt
        // body (commit lines do not start with "Type:").
        expect(prompt).not.toMatch(/\n\s*Type:\s*feat/);
    });

    it('falls back to "Commits: (none recorded)" when a PR has zero parsed commits', async () => {
        const emptyCommitsPR: ParsedPR[] = [
            {
                ...richPRs[0]!,
                commits: [],
            },
        ];
        const { client, create } = fakeOpenAIWithSpy(MINIMAL_AI_REPLY);
        await generateReport(
            { ...richInput, prs: emptyCommitsPR },
            { apiKey: 'sk-test', client },
        );
        const prompt = lastPromptSentTo(create);
        expect(prompt).toContain('Commits: (none recorded)');
    });
});
