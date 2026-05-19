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

/**
 * Rewrite the `version` field of a package.json byte-surgically.
 *
 * Why not `JSON.parse` → mutate → `JSON.stringify`: a full round-trip
 * reformats the entire file (loses author whitespace choices around colons,
 * compacts multi-line arrays, fixes/breaks tabs vs spaces, drops the exact
 * blank-line placement Prettier or the user's formatter set). That makes
 * every release commit also a "reformat the world" commit, which trips
 * Prettier/ESLint `format-on-commit` hooks downstream.
 *
 * Approach: parse JSON only to discover the *current* version string. Then
 * use a regex anchored on the literal current value to find the one
 * `"version": "<current>"` occurrence in the source text and swap just the
 * value bytes. Every other byte of the file — quotes, indentation, comments
 * (in JSONC tooling), trailing newlines, key order — is preserved verbatim.
 *
 * Falls back to the JSON round-trip when surgical replace can't find a
 * match (file has no `version` field, value is not a literal string, etc.).
 */
async function rewriteVersion(absPath: string, nextVersion: string): Promise<void> {
    const raw = await fs.readFile(absPath, 'utf8');

    let currentVersion: string | undefined;
    try {
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (typeof parsed.version === 'string') {
            currentVersion = parsed.version;
        }
    } catch {
        // Fall through to surgical replace anyway — a JSONC file with
        // comments might fail JSON.parse but still be surgically editable.
    }

    if (currentVersion !== undefined) {
        const escaped = currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match the first `"version"\s*:\s*"<current>"` occurrence — for
        // package.json this is reliably the top-level field. Non-global,
        // so only the first match is replaced.
        const re = new RegExp(`("version"\\s*:\\s*)"${escaped}"`);
        if (re.test(raw)) {
            const out = raw.replace(re, `$1"${nextVersion}"`);
            if (out !== raw) {
                await fs.writeFile(absPath, out, 'utf8');
                return;
            }
        }
    }

    // Fallback: full JSON round-trip with detected indent. Triggers only
    // when the surgical regex can't match — e.g. the file has no `version`
    // field, the value isn't a plain string, or the file isn't pure JSON.
    const indent = detectIndent(raw);
    const obj = JSON.parse(raw) as Record<string, unknown>;
    obj['version'] = nextVersion;
    const fallback = JSON.stringify(obj, null, indent) + (raw.endsWith('\n') ? '\n' : '');
    await fs.writeFile(absPath, fallback, 'utf8');
}

function detectIndent(source: string): number {
    const match = /\n( {2,8})"/.exec(source);
    if (match && match[1]) return match[1].length;
    return 2;
}
