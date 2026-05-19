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
