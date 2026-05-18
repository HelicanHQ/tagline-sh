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
 * Prepend the plan's `changelogContent` to `CHANGELOG.md` — single-repo and
 * monorepo flavors.
 *
 * Single-repo: writes to `<root>/CHANGELOG.md`.
 *
 * Monorepo: writes to *each affected* package's CHANGELOG.md, AND to a root
 * `CHANGELOG.md` that aggregates everything. The plan's `changelogContent` is
 * the aggregate form; per-package forms are derived from
 * `monorepoInfo.packages[*].affectedPRs`. Per PLAN.md §15.
 */
export async function writeChangelog(
    plan: ReleasePlan,
    workspaceRoot: string,
): Promise<WriteChangelogResult> {
    const touched: string[] = [];

    if (plan.isMonorepo && plan.monorepoInfo) {
        for (const pkg of plan.monorepoInfo.packages) {
            if (pkg.affectedPRs.length === 0) continue;
            const target = path.join(workspaceRoot, pkg.changelogPath);
            await prependToFile(target, plan.changelogContent);
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
