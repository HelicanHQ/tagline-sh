import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Heading, List, ListItem, Root, Text } from 'mdast';
import {
    DEFAULT_CONFIG,
    DEFAULT_VERSIONING,
    type ReleaseChannel,
    type RepoConfig,
    type VersioningConfig,
    type VersioningScheme,
} from '@tagline-sh/shared';
import type { GitHubReader, RepoRef } from '~/app/services/github-reader';

const CONFIG_FILE = process.env.CONFIG_FILE ?? '.release-agent.md';

// Section names we parse deterministically. Everything else goes into
// `customContext` / `releaseNotesStyle` and is forwarded to the AI prompt.
const BRANCHES_HEADING = /^branches$/i;
const PRERELEASE_HEADING = /^pre[- ]?release tags?$/i;
const NOTES_HEADING = /^release notes? style$/i;
const VERSIONING_HEADING = /^versioning$/i;
const CHANNELS_HEADING = /^channels$/i;

const VALID_SCHEMES: ReadonlySet<VersioningScheme> = new Set(['semver', 'calver', 'incremental']);

interface ParsedSections {
    branches: Record<string, string>;
    preRelease: Record<string, string>;
    versioning: Record<string, string>;
    /** Ordered, case-preserving `- <branch>: <tier|suffix>` pairs from `## Channels`. */
    channels: Array<{ branch: string; label: string }>;
    notesStyle: string;
    customContext: string;
}

/**
 * Fetch `.release-agent.md` from the repo root, parse the known sections, and
 * pass everything else through to the AI prompt as free-form context.
 *
 * Falls back to `DEFAULT_CONFIG` on 404 — the file is optional by design.
 */
export async function readRepoConfig(
    reader: GitHubReader,
    repo: RepoRef,
    ref?: string,
): Promise<RepoConfig> {
    const content = await reader.getFileContent(repo, CONFIG_FILE, ref);
    if (content == null) return DEFAULT_CONFIG;

    const sections = parseSections(content);

    const branches = {
        production: sections.branches['production'] ?? DEFAULT_CONFIG.branches.production,
        staging: sections.branches['staging'] ?? DEFAULT_CONFIG.branches.staging,
        development: sections.branches['development'] ?? DEFAULT_CONFIG.branches.development,
    };
    const preReleaseSuffix = {
        staging:
            sections.preRelease['staging suffix'] ??
            sections.preRelease['staging'] ??
            DEFAULT_CONFIG.preReleaseSuffix.staging,
        development:
            sections.preRelease['development suffix'] ??
            sections.preRelease['development'] ??
            DEFAULT_CONFIG.preReleaseSuffix.development,
    };

    return {
        channels: resolveChannels(sections.channels, branches, preReleaseSuffix),
        branches,
        preReleaseSuffix,
        versioning: resolveVersioning(sections.versioning),
        releaseNotesStyle: sections.notesStyle.trim(),
        customContext: sections.customContext.trim(),
        rawContent: content,
    };
}

/**
 * Build the channel list. An explicit `## Channels` section wins; otherwise we
 * derive channels from the legacy `## Branches` + `## Pre-release Tags` config
 * so existing repos gain the channel model for free:
 *   production → stable, staging → rc, development → alpha.
 *
 * In `## Channels`, each `- <branch>: <label>` line means: `stable` → the
 * production line (clean versions), anything else → a pre-release channel whose
 * `<label>` is the suffix (`alpha`, `rc`, `beta`, …). Branch names keep their
 * original case; labels are lower-cased.
 */
function resolveChannels(
    pairs: Array<{ branch: string; label: string }>,
    branches: RepoConfig['branches'],
    preReleaseSuffix: RepoConfig['preReleaseSuffix'],
): ReleaseChannel[] {
    if (pairs.length > 0) {
        return pairs.map(({ branch, label }) => {
            const tierLabel = label.toLowerCase();
            return tierLabel === 'stable'
                ? { branch, tier: 'stable', suffix: null }
                : { branch, tier: 'prerelease', suffix: tierLabel };
        });
    }

    const channels: ReleaseChannel[] = [
        { branch: branches.production, tier: 'stable', suffix: null },
    ];
    if (branches.staging) {
        channels.push({
            branch: branches.staging,
            tier: 'prerelease',
            suffix: preReleaseSuffix.staging,
        });
    }
    if (branches.development) {
        channels.push({
            branch: branches.development,
            tier: 'prerelease',
            suffix: preReleaseSuffix.development,
        });
    }
    return channels;
}

/**
 * Translate the parsed `## Versioning` key/value pairs into a `VersioningConfig`.
 *
 * Recognized keys:
 *   - `scheme`: one of `semver`, `calver`, `incremental` (case-insensitive)
 *   - `pattern`: calver pattern string; only meaningful when `scheme: calver`
 *
 * Unknown / invalid scheme values fall back to the semver default rather than
 * throwing — a misconfigured file shouldn't break the bot. The user will see
 * the silently-applied default reflected in the report's reasoning section.
 */
function resolveVersioning(entries: Record<string, string>): VersioningConfig {
    const rawScheme = (entries['scheme'] ?? '').trim().toLowerCase();
    const scheme: VersioningScheme = VALID_SCHEMES.has(rawScheme as VersioningScheme)
        ? (rawScheme as VersioningScheme)
        : DEFAULT_VERSIONING.scheme;

    const pattern = entries['pattern']?.trim() ?? null;
    return { scheme, pattern: pattern && pattern.length > 0 ? pattern : null };
}

// --- Markdown parsing --------------------------------------------------------

/**
 * Walk the Markdown AST and bucket sections into structured data (`branches`,
 * `preRelease`, `notesStyle`) and a free-form `customContext` blob.
 *
 * Approach: split the doc by H2 headings, classify each section by its heading
 * text, and decide what to do with the body.
 */
function parseSections(markdown: string): ParsedSections {
    const tree = unified().use(remarkParse).parse(markdown) as Root;

    const branches: Record<string, string> = {};
    const preRelease: Record<string, string> = {};
    const versioning: Record<string, string> = {};
    const channels: Array<{ branch: string; label: string }> = [];
    const notesStyleParts: string[] = [];
    const customContextParts: string[] = [];

    // Walk top-level children. Each H2 starts a new section; child nodes until
    // the next H2 belong to that section.
    let currentHeading: string | null = null;
    let currentBody: typeof tree.children = [];

    const flush = (): void => {
        if (!currentHeading) {
            // Pre-amble (anything before the first heading) goes into custom context.
            if (currentBody.length) {
                customContextParts.push(stringifyNodes(markdown, currentBody));
            }
            return;
        }

        if (BRANCHES_HEADING.test(currentHeading)) {
            Object.assign(branches, extractKeyValueList(currentBody));
        } else if (PRERELEASE_HEADING.test(currentHeading)) {
            Object.assign(preRelease, extractKeyValueList(currentBody));
        } else if (VERSIONING_HEADING.test(currentHeading)) {
            Object.assign(versioning, extractKeyValueList(currentBody));
        } else if (CHANNELS_HEADING.test(currentHeading)) {
            channels.push(...extractChannelPairs(currentBody));
        } else if (NOTES_HEADING.test(currentHeading)) {
            notesStyleParts.push(stringifyNodes(markdown, currentBody));
        } else {
            // Anything else is passed through verbatim with its heading.
            customContextParts.push(
                `## ${currentHeading}\n\n${stringifyNodes(markdown, currentBody)}`,
            );
        }
    };

    for (const child of tree.children) {
        if (child.type === 'heading' && (child as Heading).depth === 2) {
            flush();
            currentHeading = headingText(child as Heading);
            currentBody = [];
        } else {
            currentBody.push(child);
        }
    }
    flush();

    return {
        branches,
        preRelease,
        versioning,
        channels,
        notesStyle: notesStyleParts.join('\n\n'),
        customContext: customContextParts.join('\n\n'),
    };
}

/**
 * Extract ordered `- <branch>: <label>` pairs from the `## Channels` list,
 * preserving the branch name's original case (git branch names are
 * case-sensitive, unlike the lower-cased keys in `extractKeyValueList`).
 */
function extractChannelPairs(nodes: Root['children']): Array<{ branch: string; label: string }> {
    const out: Array<{ branch: string; label: string }> = [];
    for (const node of nodes) {
        if (node.type !== 'list') continue;
        for (const item of (node as List).children) {
            const line = listItemText(item as ListItem);
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const branch = line.slice(0, colonIdx).trim();
            const label = line.slice(colonIdx + 1).trim();
            if (branch && label) out.push({ branch, label });
        }
    }
    return out;
}

function headingText(heading: Heading): string {
    let buf = '';
    visit(heading, 'text', (node: Text) => {
        buf += node.value;
    });
    return buf.trim();
}

/**
 * Extract key→value pairs from a `- key: value` bulleted list. Used for the
 * `## Branches` and `## Pre-release Tags` sections, which are intentionally
 * structured so we can parse them without ambiguity.
 *
 * Keys are lower-cased; values keep their original casing.
 */
function extractKeyValueList(nodes: Root['children']): Record<string, string> {
    const out: Record<string, string> = {};
    for (const node of nodes) {
        if (node.type !== 'list') continue;
        for (const item of (node as List).children) {
            const line = listItemText(item as ListItem);
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const key = line.slice(0, colonIdx).trim().toLowerCase();
            const value = line.slice(colonIdx + 1).trim();
            if (key && value) out[key] = value;
        }
    }
    return out;
}

function listItemText(item: ListItem): string {
    let buf = '';
    visit(item, 'text', (node: Text) => {
        buf += node.value;
    });
    return buf.trim();
}

/**
 * Slice the original source for a set of AST nodes. We use position info from
 * remark rather than re-stringifying so the user's prose is preserved verbatim
 * (including formatting nuances the AI prompt benefits from).
 */
function stringifyNodes(source: string, nodes: Root['children']): string {
    if (nodes.length === 0) return '';
    const first = nodes[0]?.position?.start.offset ?? 0;
    const last = nodes[nodes.length - 1]?.position?.end.offset ?? source.length;
    return source.slice(first, last).trim();
}
