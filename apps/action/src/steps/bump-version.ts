import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReleasePlan } from '@tagline-sh/shared';

export interface BumpResult {
    files: string[];
}

/**
 * Update `package.json#version` in-place.
 *
 * Single-repo (`plan.packages` is empty): bump the root `package.json` to
 * `plan.nextVersion`. Unchanged from pre-M3.
 *
 * Monorepo (M3 — `plan.packages` is non-empty): each entry in `plan.packages`
 * gets bumped to its own `nextVersion`. The root `package.json` is left alone
 * because in a true monorepo there's no "the version" — release events are
 * package-scoped. (Previously a known bug: every package was bumped to the
 * same string; the root's monorepoInfo had per-package versions but they
 * were ignored at bump time.)
 *
 * Mutates files on disk relative to `workspaceRoot`. Returns the relative
 * paths it touched so callers can `git add` them precisely.
 */
export async function bumpVersion(
    plan: ReleasePlan,
    workspaceRoot: string,
): Promise<BumpResult> {
    const touched: string[] = [];

    if (plan.packages.length > 0) {
        for (const pkg of plan.packages) {
            const absPath = path.join(workspaceRoot, pkg.packageJsonPath);
            await rewriteVersion(absPath, pkg.nextVersion);
            touched.push(pkg.packageJsonPath);
        }
    } else {
        const rootPath = path.join(workspaceRoot, 'package.json');
        if (await fileHasVersion(rootPath)) {
            await rewriteVersion(rootPath, plan.nextVersion);
            touched.push('package.json');
        }
    }

    return { files: touched };
}

async function fileHasVersion(absPath: string): Promise<boolean> {
    try {
        const raw = await fs.readFile(absPath, 'utf8');
        const pkg = JSON.parse(raw) as { version?: string };
        return typeof pkg.version === 'string';
    } catch {
        return false;
    }
}

async function rewriteVersion(absPath: string, nextVersion: string): Promise<void> {
    const raw = await fs.readFile(absPath, 'utf8');
    const indent = detectIndent(raw);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed['version'] = nextVersion;
    const out = JSON.stringify(parsed, null, indent) + (raw.endsWith('\n') ? '\n' : '');
    await fs.writeFile(absPath, out, 'utf8');
}

function detectIndent(source: string): number {
    const match = /\n( {2,8})"/.exec(source);
    if (match && match[1]) return match[1].length;
    return 2;
}
