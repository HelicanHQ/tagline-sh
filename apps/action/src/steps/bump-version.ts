import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReleasePlan } from '@tagline-sh/shared';

export interface BumpResult {
    files: string[];
}

/**
 * Update `package.json#version` in-place.
 *
 * For monorepos, every package mentioned in `plan.monorepoInfo.packages` gets
 * bumped. The root `package.json` is bumped only when it has a version
 * (typical: not a monorepo root, OR a monorepo root that itself ships).
 *
 * Mutates files on disk relative to `workspaceRoot`. Returns the relative
 * paths it touched so callers can `git add` them precisely.
 */
export async function bumpVersion(
    plan: ReleasePlan,
    workspaceRoot: string,
): Promise<BumpResult> {
    const touched: string[] = [];

    if (plan.isMonorepo && plan.monorepoInfo) {
        for (const pkg of plan.monorepoInfo.packages) {
            await rewriteVersion(path.join(workspaceRoot, pkg.packageJsonPath), plan.nextVersion);
            touched.push(pkg.packageJsonPath);
        }
        if (plan.monorepoInfo.rootPackage) {
            const rootPath = plan.monorepoInfo.rootPackage.packageJsonPath;
            if (await fileHasVersion(path.join(workspaceRoot, rootPath))) {
                await rewriteVersion(path.join(workspaceRoot, rootPath), plan.nextVersion);
                touched.push(rootPath);
            }
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
