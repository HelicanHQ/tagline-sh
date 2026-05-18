import OpenAI from 'openai';
import { AI_DEFAULTS, type ParsedPR, type RepoConfig } from '@tagline-sh/shared';
import { renderChangelogEntry } from './changelog-writer.js';

export interface ReportGeneratorInput {
    prs: ParsedPR[];
    suggestedBump: string;
    suggestedVersion: string;
    config: RepoConfig;
}

export interface AIReportOutput {
    reasoning: string;
    changelogPreview: string;
    /** True iff the AI call succeeded; false means we returned the deterministic fallback. */
    aiUsed: boolean;
}

const SYSTEM_PROMPT =
    'You are a release manager assistant for software engineering teams. ' +
    'You help generate clear, accurate release reports based on merged pull requests. ' +
    'Be concise and technical. Do not embellish or invent features. ' +
    'Only describe what is in the provided PR data.';

function buildUserPrompt(input: ReportGeneratorInput): string {
    const { prs, suggestedBump, suggestedVersion, config } = input;
    const prLines = prs
        .map((pr) => {
            const types = pr.commits.map((c) => c.type).join(', ') || 'chore';
            const tickets = pr.tickets.join(', ') || 'none';
            const body = pr.bodyExcerpt ? `\n  Description: ${pr.bodyExcerpt}` : '';
            return `- PR #${pr.number}: ${pr.title} (by @${pr.author})\n  Type: ${types}\n  Tickets: ${tickets}${body}`;
        })
        .join('\n');

    const style =
        config.releaseNotesStyle ||
        'Write clear, concise release notes for a developer audience.';
    const ctx = config.customContext ? `\n\n${config.customContext}` : '';
    const scheme = config.versioning.scheme;

    // Scheme-specific guidance for the reasoning. For semver we ask the model
    // to justify the bump category; for calver/incremental the version number
    // is mechanically derived, so we ask the model to summarize the release's
    // scope instead.
    const reasoningTask =
        scheme === 'semver'
            ? `1. Write 2–3 sentences explaining WHY a \`${suggestedBump}\` bump is appropriate, ` +
              'referencing specific PRs by number.'
            : `1. Write 2–3 sentences summarizing what's in this release (version \`${suggestedVersion}\`, ` +
              `scheme: ${scheme}). Reference specific PRs by number. Do not discuss semver bump categories — ` +
              'the version is computed mechanically from the scheme.';

    const versionLine =
        scheme === 'semver'
            ? `## Suggested version bump: ${suggestedBump} (→ ${suggestedVersion})`
            : `## Computed next version: ${suggestedVersion} (scheme: ${scheme})`;

    return [
        'Generate a release report summary based on these merged pull requests.',
        '',
        '## Merged PRs',
        prLines,
        '',
        versionLine,
        '',
        '## Repository context (from .release-agent.md):',
        style + ctx,
        '',
        '## Your task',
        reasoningTask,
        '2. Write a changelog preview in Keep a Changelog format (### Added, ### Fixed,',
        '   ### Changed, ### Removed sections — only include sections with content).',
        '   Each entry should be a single line. Reference PR numbers and ticket numbers where available.',
        '',
        'Respond with valid JSON matching this schema:',
        '{',
        '  "reasoning": "<2-3 sentence explanation>",',
        '  "changelogPreview": "<markdown formatted changelog>"',
        '}',
    ].join('\n');
}

const FALLBACK_REASONING = 'AI unavailable — manual review required';

/**
 * Build a deterministic report from parsed PRs alone, without any AI call.
 * Used both as a fallback when the AI provider fails, and as the basis for the
 * changelog that actually gets written to disk (the AI's preview is for the
 * report comment only — the action regenerates from PRs to keep things honest).
 */
export function deterministicReport(input: ReportGeneratorInput): AIReportOutput {
    return {
        reasoning: FALLBACK_REASONING,
        changelogPreview: renderChangelogEntry({
            version: input.suggestedVersion,
            prs: input.prs,
        }),
        aiUsed: false,
    };
}

export interface AIClientOptions {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    /** Used in tests to inject a pre-built OpenAI client. */
    client?: OpenAI;
    /** Max ms before we give up and use the deterministic fallback. */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Generate a release report using an OpenAI-compatible chat completions
 * endpoint. The provider is configured via the OpenAI SDK's `baseURL` override
 * (PLAN.md §14) — defaults to OpenRouter.
 *
 * If the AI call fails for any reason (timeout, rate limit, malformed JSON,
 * bad credentials), we fall back to `deterministicReport()` and never throw.
 * The bot's UX guarantees that `/release-report` always produces output;
 * failures degrade gracefully.
 */
export async function generateReport(
    input: ReportGeneratorInput,
    options: AIClientOptions,
): Promise<AIReportOutput> {
    const model = options.model ?? AI_DEFAULTS.model;
    const baseURL = options.baseUrl ?? AI_DEFAULTS.baseUrl;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const client =
        options.client ??
        new OpenAI({
            apiKey: options.apiKey,
            baseURL,
        });

    try {
        const completion = await client.chat.completions.create(
            {
                model,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: buildUserPrompt(input) },
                ],
                response_format: { type: 'json_object' },
                temperature: 0.2,
            },
            { timeout: timeoutMs },
        );

        const raw = completion.choices[0]?.message?.content;
        if (!raw) return deterministicReport(input);

        const parsed = JSON.parse(raw) as { reasoning?: unknown; changelogPreview?: unknown };
        const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : null;
        const changelogPreview =
            typeof parsed.changelogPreview === 'string' ? parsed.changelogPreview : null;

        if (!reasoning || !changelogPreview) {
            return deterministicReport(input);
        }

        return {
            reasoning,
            changelogPreview,
            aiUsed: true,
        };
    } catch {
        return deterministicReport(input);
    }
}
