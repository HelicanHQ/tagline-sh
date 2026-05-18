import { parse as parseYaml } from 'yaml';
import picomatch from 'picomatch';
import type { MonorepoInfo, MonorepoType, PackageInfo, ParsedPR } from '@tagline-sh/shared';
import type { GitHubReader, RepoRef } from './github-reader.js';

// Detection priority per PLAN.md §12 — first match wins.
const DETECTORS: ReadonlyArray<{
    file: string;
    type: Exclude<MonorepoType, 'npm-workspaces' | 'yarn-workspaces' | 'none'>;
}> = [
    { file: 'pnpm-workspace.yaml', type: 'pnpm-workspaces' },
    { file: 'turbo.json', type: 'turborepo' },
    { file: 'nx.json', type: 'nx' },
    { file: 'lerna.json', type: 'lerna' },
];

interface MinimalPackageJson {
    name?: string;
    version?: string;
    workspaces?: string[] | { packages?: string[] };
    packageManager?: string;
}

function safeParseJson<T>(text: string | null): T | null {
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

function safeParseYaml<T>(text: string | null): T | null {
    if (!text) return null;
    try {
        return parseYaml(text) as T;
    } catch {
        return null;
    }
}

/**
 * Identify the monorepo flavor by inspecting marker files at the repo root.
 * Returns a tuple of (type, raw-globs) where raw-globs are the workspace
 * patterns extracted from the marker file. The caller then expands them.
 *
 * For npm/yarn workspaces we look at `package.json#workspaces` (or `.packages`).
 * We distinguish npm vs yarn by checking `packageManager:` — falling back to
 * `npm` since it's the de-facto default.
 */
async function detectFlavor(
    reader: GitHubReader,
    repo: RepoRef,
    ref?: string,
): Promise<{ type: MonorepoType; globs: string[] } | null> {
    for (const d of DETECTORS) {
        const content = await reader.getFileContent(repo, d.file, ref);
        if (content == null) continue;

        if (d.type === 'pnpm-workspaces') {
            const parsed = safeParseYaml<{ packages?: string[] }>(content);
            return { type: 'pnpm-workspaces', globs: parsed?.packages ?? [] };
        }
        if (d.type === 'turborepo') {
            // Turborepo uses package.json#workspaces for the package list.
            const rootPkg = await reader.getFileContent(repo, 'package.json', ref);
            const parsed = safeParseJson<MinimalPackageJson>(rootPkg);
            return { type: 'turborepo', globs: normalizeWorkspaces(parsed) };
        }
        if (d.type === 'nx') {
            // Nx workspaces typically list projects under `projects` in nx.json
            // (older format) or via `apps/*` + `libs/*` conventionally.
            // We accept both: explicit projects (already paths) or default globs.
            const parsed = safeParseJson<{ projects?: Record<string, unknown> }>(content);
            const projectPaths = parsed?.projects ? Object.keys(parsed.projects) : [];
            const globs = projectPaths.length > 0 ? projectPaths : ['apps/*', 'libs/*'];
            return { type: 'nx', globs };
        }
        if (d.type === 'lerna') {
            const parsed = safeParseJson<{ packages?: string[] }>(content);
            return { type: 'lerna', globs: parsed?.packages ?? ['packages/*'] };
        }
    }

    // Fallback: bare npm/yarn workspaces.
    const rootPkg = await reader.getFileContent(repo, 'package.json', ref);
    const parsed = safeParseJson<MinimalPackageJson>(rootPkg);
    const globs = normalizeWorkspaces(parsed);
    if (globs.length === 0) return null;

    const isYarn = typeof parsed?.packageManager === 'string' && parsed.packageManager.startsWith('yarn');
    return { type: isYarn ? 'yarn-workspaces' : 'npm-workspaces', globs };
}

function normalizeWorkspaces(pkg: MinimalPackageJson | null): string[] {
    if (!pkg?.workspaces) return [];
    if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
    return pkg.workspaces.packages ?? [];
}

/**
 * Expand workspace globs to concrete directory paths by walking the top two
 * path segments of the glob (e.g. `packages/*` → list everything in
 * `packages/`). This avoids a full recursive tree fetch, which would be
 * expensive for big repos and unnecessary because every monorepo convention
 * lists packages within a flat parent directory.
 */
async function expandGlobs(
    reader: GitHubReader,
    repo: RepoRef,
    globs: string[],
    ref?: string,
): Promise<string[]> {
    const candidates = new Set<string>();

    for (const g of globs) {
        const trimmed = g.replace(/^\.\//, '').replace(/\/$/, '');
        const literal = !trimmed.includes('*');
        if (literal) {
            candidates.add(trimmed);
            continue;
        }

        // Glob with a wildcard — list the immediate parent directory and let
        // picomatch filter.
        const slashIdx = trimmed.indexOf('/');
        const parent = slashIdx === -1 ? '.' : trimmed.slice(0, slashIdx);
        const matcher = picomatch(trimmed);
        const children = await reader.listDirectory(repo, parent, ref);
        for (const child of children) {
            const candidate = parent === '.' ? child : `${parent}/${child}`;
            if (matcher(candidate)) candidates.add(candidate);
        }
    }

    return [...candidates];
}

async function readPackageInfo(
    reader: GitHubReader,
    repo: RepoRef,
    path: string,
    ref?: string,
): Promise<PackageInfo | null> {
    const packageJsonPath = path === '.' ? 'package.json' : `${path}/package.json`;
    const raw = await reader.getFileContent(repo, packageJsonPath, ref);
    const parsed = safeParseJson<MinimalPackageJson>(raw);
    if (!parsed || !parsed.name) return null;

    return {
        name: parsed.name,
        path,
        currentVersion: parsed.version ?? '0.0.0',
        packageJsonPath,
        changelogPath: path === '.' ? 'CHANGELOG.md' : `${path}/CHANGELOG.md`,
        affectedPRs: [],
    };
}

/**
 * Detect the monorepo (or lack thereof) for a given repo + ref.
 *
 * Returns a `MonorepoInfo` even for single-repo projects — in that case `type`
 * is `'none'` and `packages` is empty. The root `package.json` is exposed via
 * `rootPackage` when present.
 */
export async function detectMonorepo(
    reader: GitHubReader,
    repo: RepoRef,
    ref?: string,
): Promise<MonorepoInfo> {
    const rootPackage = await readPackageInfo(reader, repo, '.', ref);
    const flavor = await detectFlavor(reader, repo, ref);

    if (!flavor) {
        return {
            type: 'none',
            packages: [],
            rootPackage,
        };
    }

    const paths = await expandGlobs(reader, repo, flavor.globs, ref);
    const packages: PackageInfo[] = [];
    for (const p of paths) {
        const info = await readPackageInfo(reader, repo, p, ref);
        if (info) packages.push(info);
    }

    return { type: flavor.type, packages, rootPackage };
}

/**
 * Assign each PR to the packages it modified. A PR that touches
 * `packages/api/src/x.ts` is attributed to the package whose `path` is
 * `packages/api`. PRs that touch nothing under any package path are not
 * assigned to anything (caller can decide whether they apply to root).
 *
 * Returns a new `MonorepoInfo` with `affectedPRs` filled in. Pure function —
 * does not mutate the input.
 */
export function attributePRsToPackages(
    info: MonorepoInfo,
    prsWithFiles: Array<{ pr: ParsedPR; files: string[] }>,
): MonorepoInfo {
    const updatedPackages = info.packages.map((pkg) => {
        const prefix = pkg.path === '.' ? '' : `${pkg.path}/`;
        const affected = prsWithFiles
            .filter(({ files }) =>
                files.some((f) => (prefix === '' ? true : f.startsWith(prefix))),
            )
            .map(({ pr }) => pr);
        return { ...pkg, affectedPRs: affected };
    });

    return { ...info, packages: updatedPackages };
}
