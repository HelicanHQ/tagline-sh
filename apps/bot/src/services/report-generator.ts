import OpenAI from 'openai';
import {
    AI_DEFAULTS,
    buildSummaryMarkdown,
    formatSummaryDate,
    type ParsedPR,
    type ReleaseSummary,
    type RepoConfig,
} from '@tagline-sh/shared';
import { renderChangelogEntry } from '~/app/services/changelog-writer';

export interface ReportGeneratorInput {
    prs: ParsedPR[];
    suggestedBump: string;
    suggestedVersion: string;
    config: RepoConfig;
    /** Injectable "now" for deterministic tests. Defaults to `new Date()`. */
    now?: Date;
}

export interface AIReportOutput {
    reasoning: string;
    changelogPreview: string;
    /**
     * Plain-language summary for non-technical audiences (PLAN_ADDENDUM.md §1).
     * Always present — produced by the AI when available, by
     * `buildFallbackSummary()` otherwise.
     */
    summary: ReleaseSummary;
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
        config.releaseNotesStyle || 'Write clear, concise release notes for a developer audience.';
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
        '3. Write a plain-language release summary for a non-technical audience (product owners,',
        '   customers, stakeholders). Rules:',
        '   - No PR numbers, no commit types (no "feat:", no "#342").',
        '   - No technical jargon unless unavoidable.',
        '   - `headline`: one sentence — the single most important thing in this release.',
        '   - `body`: 2–4 sentences describing what changed and why users care.',
        '   - `highlights`: 2–5 bullet points in plain English. User-facing language only.',
        '',
        '   Example of good output:',
        '   {',
        '     "headline": "You can now log in with Google and export your data to CSV.",',
        '     "body": "This release focuses on two things users have been asking for: a faster',
        '              login option and a way to get their data out. We also fixed a login issue',
        '              that was affecting some users on mobile.",',
        '     "highlights": [',
        '       "Sign in with Google — no password required",',
        '       "Export any table to CSV from the dashboard",',
        '       "Fixed login bug on mobile Safari"',
        '     ]',
        '   }',
        '',
        'Respond with valid JSON matching this schema:',
        '{',
        '  "reasoning": "<2-3 sentence explanation>",',
        '  "changelogPreview": "<markdown formatted changelog>",',
        '  "releaseSummary": {',
        '    "headline": "<one sentence>",',
        '    "body": "<2-4 sentences>",',
        '    "highlights": ["<bullet 1>", "<bullet 2>", ...]',
        '  }',
        '}',
    ].join('\n');
}

const FALLBACK_REASONING = 'AI unavailable — manual review required';

/**
 * Deterministic plain-language summary, built without any AI call.
 *
 * The shape follows PLAN_ADDENDUM.md §4: prefer feat-bump PRs as the first
 * highlights, then fix PRs, capped at 5 total. The final safety net (use the
 * first PR's title) ensures the `highlights` array is never empty — the zod
 * schema enforces `min(1)`, and an empty array would otherwise reject the plan
 * at the action boundary even though everything else is well-formed.
 */
export function buildFallbackSummary(
    prs: ParsedPR[],
    nextVersion: string,
    _config: RepoConfig,
    now: Date = new Date(),
): ReleaseSummary {
    const featPRs = prs.filter((pr) => pr.suggestedBump === 'minor');
    const fixPRs = prs.filter((pr) => pr.commits.some((c) => c.type === 'fix'));

    const highlights: string[] = [];
    for (const pr of featPRs.slice(0, 3)) highlights.push(pr.title);
    for (const pr of fixPRs.slice(0, 2)) {
        if (!highlights.includes(pr.title)) highlights.push(pr.title);
    }
    // Safety net: schema requires at least one highlight. Fall back to the
    // first PR's title if neither feat nor fix yielded anything (e.g. an
    // all-chore release).
    if (highlights.length === 0 && prs.length > 0) {
        highlights.push(prs[0]!.title);
    }
    if (highlights.length === 0) {
        // No PRs at all — caller usually short-circuits before this point, but
        // a defensive placeholder keeps the type-system happy and the schema
        // satisfied.
        highlights.push(`Release ${nextVersion}`);
    }

    const date = formatSummaryDate(now);
    const versionLabel = nextVersion.startsWith('v') ? nextVersion.slice(1) : nextVersion;
    const headline = `v${versionLabel} includes ${prs.length} update${prs.length !== 1 ? 's' : ''}.`;
    const body = 'See the changelog below for the full list of changes.';

    // Build rawMarkdown via the same shared helper the action will use — keeps
    // bot and action byte-equal for the same summary.
    const intermediate: ReleaseSummary = {
        version: versionLabel,
        date,
        headline,
        body,
        highlights: highlights.slice(0, 5),
        rawMarkdown: '',
    };
    return { ...intermediate, rawMarkdown: buildSummaryMarkdown(intermediate) };
}

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
        summary: buildFallbackSummary(input.prs, input.suggestedVersion, input.config, input.now),
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
 *
 * Partial-success handling: if the model returns valid `reasoning` and
 * `changelogPreview` but a malformed `releaseSummary` (e.g. wrong shape,
 * empty highlights, too many highlights), we use the AI text for the first
 * two fields and the deterministic fallback summary for the third. Preserves
 * the most user value when the model is partially right.
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

        const parsed = JSON.parse(raw) as {
            reasoning?: unknown;
            changelogPreview?: unknown;
            releaseSummary?: unknown;
        };
        const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : null;
        const changelogPreview =
            typeof parsed.changelogPreview === 'string' ? parsed.changelogPreview : null;

        if (!reasoning || !changelogPreview) {
            return deterministicReport(input);
        }

        // Try to extract the AI-generated summary. If anything is off, drop
        // back to the deterministic summary for this field only — the other
        // two fields remain AI-produced.
        const aiSummary = parseAISummary(parsed.releaseSummary, input.suggestedVersion, input.now);
        const summary =
            aiSummary ??
            buildFallbackSummary(input.prs, input.suggestedVersion, input.config, input.now);

        return {
            reasoning,
            changelogPreview,
            summary,
            aiUsed: true,
        };
    } catch {
        return deterministicReport(input);
    }
}

/**
 * Validate and convert the AI's `releaseSummary` field into a `ReleaseSummary`.
 *
 * The AI only produces the prose fields (`headline`, `body`, `highlights`);
 * we fill in `version`, `date`, and `rawMarkdown` from context so structural
 * fields stay deterministic and bot/action are guaranteed to render identically.
 *
 * Returns `null` if the shape is wrong in any way — caller falls back.
 */
function parseAISummary(
    raw: unknown,
    suggestedVersion: string,
    now: Date | undefined,
): ReleaseSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as { headline?: unknown; body?: unknown; highlights?: unknown };

    const headline = typeof obj.headline === 'string' ? obj.headline.trim() : '';
    const body = typeof obj.body === 'string' ? obj.body.trim() : '';
    if (!headline || !body) return null;

    if (!Array.isArray(obj.highlights)) return null;
    const highlights = obj.highlights
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.trim())
        .filter((h) => h.length > 0)
        .slice(0, 5);
    if (highlights.length === 0) return null;

    const versionLabel = suggestedVersion.startsWith('v')
        ? suggestedVersion.slice(1)
        : suggestedVersion;
    const intermediate: ReleaseSummary = {
        version: versionLabel,
        date: formatSummaryDate(now ?? new Date()),
        headline,
        body,
        highlights,
        rawMarkdown: '',
    };
    return { ...intermediate, rawMarkdown: buildSummaryMarkdown(intermediate) };
}
