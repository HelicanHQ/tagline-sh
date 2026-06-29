import {
    aggregateBumps,
    packageTagName,
    type BumpType,
    type MonorepoInfo,
    type PackageReleasePlan,
    type ReleaseChannel,
    type RepoConfig,
} from '@tagline-sh/shared';
import { computeChannelVersion } from '~/app/services/version-calculator';
import { deriveLineVersions } from '~/app/services/pr-reader';
import type { TagRef } from '~/app/services/github-reader';
import { renderChangelogEntry } from '~/app/services/changelog-writer';

export interface BuildPackagePlansInput {
    monorepoInfo: MonorepoInfo;
    branch: string;
    config: RepoConfig;
    /**
     * The release channel for `branch` (stable/alpha/rc). Drives the version
     * suffix per package. Defaults to a synthetic stable channel on `branch`
     * when omitted, so callers that haven't been updated keep clean versions.
     */
    channel?: ReleaseChannel;
    /**
     * All repo tags, used to derive each package's last-stable anchor and its
     * pre-release counter (`deriveLineVersions(tags, pkg.name)`). Empty array is
     * safe — packages fall back to their `currentVersion` as the anchor.
     */
    tags?: TagRef[];
    /**
     * Optional per-package bump overrides keyed by package name (e.g.
     * `{ '@acme/api': 'minor', '@acme/ui': 'patch' }`). When present, replaces
     * the conventional-commit-derived bump for that specific package. Names
     * not in the map are unaffected.
     *
     * Only meaningful for `semver` scheme — `calver` / `incremental` are
     * mechanical and ignore bump words. `approve.ts` rejects bump-word
     * overrides on non-semver schemes BEFORE this helper runs, so we don't
     * have to re-validate here.
     */
    bumpOverrides?: Map<string, BumpType>;
    /** Optional `now` for deterministic tests; defaults to `new Date()`. */
    now?: Date;
}

/**
 * Build the per-package `PackageReleasePlan[]` for a monorepo release event.
 *
 * Inclusion rule (M3): a package is included iff it has at least one
 * attributed PR AND its computed bump is not `none`. A package with only
 * `chore` PRs has no semver-relevant changes and is skipped — this is what
 * makes "release webapp + api on the same day, but not the database" work
 * automatically. For `calver` / `incremental` schemes the `bumpType` is
 * informational; inclusion is gated on `affectedPRs.length > 0` instead.
 *
 * The function is pure — it takes the already-attributed `MonorepoInfo` and
 * spits out the plan array. Both `release-report.ts` (preview) and
 * `approve.ts` (final plan with user overrides) call it.
 */
export function buildPackagePlans(input: BuildPackagePlansInput): PackageReleasePlan[] {
    const { monorepoInfo, branch, config, bumpOverrides, now } = input;
    const scheme = config.versioning.scheme;
    const tags = input.tags ?? [];
    const channel: ReleaseChannel = input.channel ?? { branch, tier: 'stable', suffix: null };
    const plans: PackageReleasePlan[] = [];

    for (const pkg of monorepoInfo.packages) {
        if (pkg.affectedPRs.length === 0) continue;

        const aggregated = aggregateBumps(pkg.affectedPRs.map((pr) => pr.suggestedBump));
        const override = bumpOverrides?.get(pkg.name);
        const bumpType: BumpType = override ?? aggregated;

        // SemVer skips packages with no semver-relevant changes; non-semver
        // schemes include any package with PRs (the math doesn't depend on
        // bump category).
        if (scheme === 'semver' && bumpType === 'none' && !override) continue;

        const { lastStableVersion, knownVersions } = deriveLineVersions(tags, pkg.name);
        const nextVersion = computeChannelVersion({
            channel,
            lastStableVersion,
            currentVersion: pkg.currentVersion,
            bump: bumpType,
            scheme,
            pattern: config.versioning.pattern,
            knownVersions,
            now,
        });

        // Per-package CHANGELOG entry — built deterministically from the
        // package's own attributed PRs so each package's history is internally
        // consistent regardless of what landed elsewhere in the monorepo.
        const changelogContent = renderChangelogEntry({
            version: nextVersion,
            prs: pkg.affectedPRs,
        });

        plans.push({
            name: pkg.name,
            path: pkg.path,
            packageJsonPath: pkg.packageJsonPath,
            changelogPath: pkg.changelogPath,
            currentVersion: pkg.currentVersion,
            nextVersion,
            bumpType,
            prs: pkg.affectedPRs,
            changelogContent,
            tagName: packageTagName(pkg.name, nextVersion),
        });
    }

    return plans;
}

/**
 * Release-event identifier used for monorepo branch and `nextVersion`. We use
 * the UTC date because (a) it's human-readable, (b) it sorts naturally, and
 * (c) it's stable across the bot/action handoff. Multiple releases on the
 * same day pick up a `-2`, `-3` suffix at the action's branch-checkout step
 * (see `git-operations.ts`).
 *
 * The format is `event-YYYY-MM-DD` rather than just the date so the branch
 * `release/vevent-2026-05-19` still matches `isReleaseBranch()` AND is
 * visually distinguishable from a single-repo version like `release/v1.5.0`.
 */
export function monorepoEventId(now: Date = new Date()): string {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return `event-${yyyy}-${mm}-${dd}`;
}
