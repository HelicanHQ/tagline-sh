import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReleasePlan } from '@tagline-sh/shared';

export interface WriteChangelogResult {
    files: string[];
}

// CHANGELOG header used when creating a fresh file. Mirrors the bot's
// `changelog-writer.ts` to keep on-disk format consistent.
const CHANGELOG_HEADER = [
    '# Changelog',
    '',
    'All notable changes to this project are documented in this file.',
    '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
    'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
    '',
].join('\n');

/**
 * Prepend changelog entries to per-package CHANGELOGs + root CHANGELOG.
 *
 * Single-repo (`plan.packages` is empty): write `plan.changelogContent` to
 * `<root>/CHANGELOG.md`. Unchanged from pre-M3.
 *
 * Monorepo (M3 — `plan.packages` is non-empty): EACH package gets its OWN
 * `changelogContent` written to ITS OWN `CHANGELOG.md` — the previous
 * implementation wrote the same aggregate content to every package, which
 * meant `packages/api/CHANGELOG.md` contained changes from `packages/ui`
 * and vice versa. Now each package's CHANGELOG reflects only what touched
 * that package. The root `CHANGELOG.md` gets `plan.changelogContent` which
 * the bot has built as a release-event aggregator (lists package versions
 * with deep-links to per-package CHANGELOGs).
 */
export async function writeChangelog(
    plan: ReleasePlan,
    workspaceRoot: string,
): Promise<WriteChangelogResult> {
    const touched: string[] = [];

    if (plan.packages.length > 0) {
        for (const pkg of plan.packages) {
            const target = path.join(workspaceRoot, pkg.changelogPath);
            await prependToFile(target, pkg.changelogContent);
            touched.push(pkg.changelogPath);
        }
        const aggregate = path.join(workspaceRoot, 'CHANGELOG.md');
        await prependToFile(aggregate, plan.changelogContent);
        touched.push('CHANGELOG.md');
    } else {
        const target = path.join(workspaceRoot, 'CHANGELOG.md');
        await prependToFile(target, plan.changelogContent);
        touched.push('CHANGELOG.md');
    }

    return { files: touched };
}

async function prependToFile(absPath: string, newEntry: string): Promise<void> {
    const entry = newEntry.trim() + '\n';
    let existing: string | null = null;
    try {
        existing = await fs.readFile(absPath, 'utf8');
    } catch (err) {
        if (!isMissing(err)) throw err;
    }

    if (!existing || existing.trim() === '') {
        await fs.writeFile(absPath, `${CHANGELOG_HEADER}\n${entry}`, 'utf8');
        return;
    }

    const lines = existing.split('\n');
    const firstEntryIdx = lines.findIndex((l) => /^## \[/.test(l));

    let out: string;
    if (firstEntryIdx === -1) {
        const trimmed = existing.replace(/\s+$/, '');
        out = `${trimmed}\n\n${entry}`;
    } else {
        const before = lines.slice(0, firstEntryIdx).join('\n').replace(/\s+$/, '');
        const after = lines.slice(firstEntryIdx).join('\n');
        out = `${before}\n\n${entry}\n${after}`;
    }
    await fs.writeFile(absPath, out, 'utf8');
}

function isMissing(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
    );
}
