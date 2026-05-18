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

const input = {
    prs,
    suggestedBump: 'minor',
    suggestedVersion: '1.5.0',
    config: DEFAULT_CONFIG,
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
    it('returns the AI-supplied reasoning and changelog when the call succeeds', async () => {
        const client = fakeOpenAI(
            JSON.stringify({
                reasoning: 'Two new features qualify this as a minor release.',
                changelogPreview: '## [1.5.0] - 2026-05-18\n\n### Added\n\n- AI-generated\n',
            }),
        );
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        expect(out.aiUsed).toBe(true);
        expect(out.reasoning).toContain('Two new features');
        expect(out.changelogPreview).toContain('AI-generated');
    });

    it('falls back deterministically when the AI throws', async () => {
        const client = fakeOpenAI(new Error('429 rate limited'));
        const out = await generateReport(input, { apiKey: 'sk-test', client });
        expect(out.aiUsed).toBe(false);
        expect(out.reasoning).toContain('AI unavailable');
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
