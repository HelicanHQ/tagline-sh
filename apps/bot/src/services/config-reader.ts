import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Heading, List, ListItem, Root, Text } from 'mdast';
import { DEFAULT_CONFIG, type RepoConfig } from '@tagline-sh/shared';
import type { GitHubReader, RepoRef } from './github-reader.js';

const CONFIG_FILE = '.release-agent.md';

// Section names we parse deterministically. Everything else goes into
// `customContext` / `releaseNotesStyle` and is forwarded to the AI prompt.
const BRANCHES_HEADING = /^branches$/i;
const PRERELEASE_HEADING = /^pre[- ]?release tags?$/i;
const NOTES_HEADING = /^release notes? style$/i;

interface ParsedSections {
    branches: Record<string, string>;
    preRelease: Record<string, string>;
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

    return {
        branches: {
            production: sections.branches['production'] ?? DEFAULT_CONFIG.branches.production,
            staging: sections.branches['staging'] ?? DEFAULT_CONFIG.branches.staging,
            development:
                sections.branches['development'] ?? DEFAULT_CONFIG.branches.development,
        },
        preReleaseSuffix: {
            staging:
                sections.preRelease['staging suffix'] ??
                sections.preRelease['staging'] ??
                DEFAULT_CONFIG.preReleaseSuffix.staging,
            development:
                sections.preRelease['development suffix'] ??
                sections.preRelease['development'] ??
                DEFAULT_CONFIG.preReleaseSuffix.development,
        },
        releaseNotesStyle: sections.notesStyle.trim(),
        customContext: sections.customContext.trim(),
        rawContent: content,
    };
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
        } else if (NOTES_HEADING.test(currentHeading)) {
            notesStyleParts.push(stringifyNodes(markdown, currentBody));
        } else {
            // Anything else is passed through verbatim with its heading.
            customContextParts.push(`## ${currentHeading}\n\n${stringifyNodes(markdown, currentBody)}`);
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
        notesStyle: notesStyleParts.join('\n\n'),
        customContext: customContextParts.join('\n\n'),
    };
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
