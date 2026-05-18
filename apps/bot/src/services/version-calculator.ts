import semver from 'semver';
import type { BumpType, RepoConfig } from '@tagline-sh/shared';

/**
 * Compute the next version given a current version, a bump type, the active
 * branch, and the repo's config (which holds the staging/dev pre-release
 * suffixes).
 *
 * Rules from PLAN.md §13:
 *   - production branch → clean semver bump (e.g. 1.4.2 minor → 1.5.0)
 *   - staging branch    → bump + `-{staging-suffix}.0` (e.g. 1.4.2 minor → 1.5.0-rc.0)
 *   - development       → bump + `-{dev-suffix}.0`
 *   - bump === 'none'   → returns the input unchanged
 *
 * If `currentVersion` is not a valid semver string, throws — callers should
 * catch and fall back to a sensible default (e.g. `0.1.0` for first releases).
 */
export function calculateNextVersion(
    currentVersion: string,
    bumpType: BumpType,
    branch: string,
    config: RepoConfig,
): string {
    if (bumpType === 'none') return currentVersion;

    const cleaned = currentVersion.startsWith('v') ? currentVersion.slice(1) : currentVersion;
    if (!semver.valid(cleaned)) {
        throw new Error(`calculateNextVersion: '${currentVersion}' is not valid semver`);
    }

    const base = semver.inc(cleaned, bumpType);
    if (!base) {
        throw new Error(`semver.inc returned null for ${cleaned} (${bumpType})`);
    }

    if (branch === config.branches.staging) {
        return `${base}-${config.preReleaseSuffix.staging}.0`;
    }
    if (branch === config.branches.development) {
        return `${base}-${config.preReleaseSuffix.development}.0`;
    }
    return base;
}

/**
 * Version assumed for a first release (no prior tag, no `package.json#version`).
 * `0.1.0` matches the convention used by npm scaffolding and Keep-a-Changelog
 * "Unreleased" → "0.1.0" promotion examples.
 */
export const FIRST_RELEASE_VERSION = '0.1.0';
