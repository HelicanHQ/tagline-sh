// Shared types — single source of truth consumed by both apps/bot and apps/action.
// These types match PLAN.md §6 verbatim and should not be edited without coordinated
// updates to the corresponding zod schemas in ./schemas.ts.

export type CommitType =
    | 'feat'
    | 'fix'
    | 'docs'
    | 'style'
    | 'refactor'
    | 'perf'
    | 'test'
    | 'build'
    | 'ci'
    | 'chore'
    | 'revert'
    | 'breaking'
    | 'hotfix'
    | 'release';

export type BumpType = 'major' | 'minor' | 'patch' | 'none';

export type MonorepoType =
    | 'pnpm-workspaces'
    | 'npm-workspaces'
    | 'yarn-workspaces'
    | 'turborepo'
    | 'nx'
    | 'lerna'
    | 'none';

/**
 * Versioning scheme selected by the user in `.release-agent.md`. Default is
 * `semver`. `calver` requires `VersioningConfig.pattern`; `incremental` ignores
 * it. SemVer math is the only scheme that interprets `BumpType` literally —
 * CalVer is time-driven and incremental is monotonic.
 */
export type VersioningScheme = 'semver' | 'calver' | 'incremental';

export interface VersioningConfig {
    scheme: VersioningScheme;
    /**
     * Calver pattern template. Tokens: `YYYY`, `YY`, `0Y`, `MM`, `0M`, `DD`,
     * `0D`, `MICRO`. Anything else is treated as a literal separator. Must
     * include `MICRO` for calver schemes. Ignored for semver / incremental.
     */
    pattern: string | null;
}

export interface ParsedCommit {
    type: CommitType;
    scope: string | null;
    subject: string;
    body: string | null;
    isBreaking: boolean;
    sha: string;
}

export interface ParsedPR {
    number: number;
    title: string;
    url: string;
    author: string;
    mergedAt: string; // ISO timestamp
    commits: ParsedCommit[];
    tickets: string[]; // e.g. ['PROJ-123', 'PROJ-456', '#42']
    suggestedBump: BumpType; // Derived from this PR's commits
    bodyExcerpt: string | null; // First 500 chars of PR description
}

export interface PackageInfo {
    name: string;
    path: string; // Relative path from repo root
    currentVersion: string;
    packageJsonPath: string;
    changelogPath: string;
    affectedPRs: ParsedPR[]; // PRs that touched this package
}

export interface MonorepoInfo {
    type: MonorepoType;
    packages: PackageInfo[];
    rootPackage: PackageInfo | null;
}

export interface RepoConfig {
    branches: {
        production: string;
        staging: string | null;
        development: string | null;
    };
    preReleaseSuffix: {
        staging: string;
        development: string;
    };
    versioning: VersioningConfig;
    releaseNotesStyle: string;
    customContext: string;
    rawContent: string;
}

/**
 * Plain-language release notes for a non-technical audience (per
 * PLAN_ADDENDUM.md §1). Generated alongside the technical changelog from the
 * same AI call. The rationale, drawn from real user research: *"commits are
 * for developers, release notes are for users"* — most tools conflate the two
 * and ship a changelog that's "technically correct and completely useless."
 *
 * Field guarantees:
 *   - `headline` — one sentence; the single most important thing in the release.
 *   - `body` — 2–4 sentences in plain English. No PR numbers. No commit types.
 *   - `highlights` — 1–5 bullets. Length is enforced at the zod boundary
 *     (`schemas.ts#ReleaseSummarySchema`); TypeScript can't model it cleanly.
 *   - `rawMarkdown` — the canonical paste artifact: the full formatted summary
 *     ready to drop into Slack/Beamer/email. Built once via
 *     `buildSummaryMarkdown()`; humans copy this, never the structured fields.
 */
export interface ReleaseSummary {
    version: string;
    /** Formatted for humans: e.g. `"May 18, 2026"`. */
    date: string;
    headline: string;
    body: string;
    highlights: string[];
    rawMarkdown: string;
}

export interface ReleaseReport {
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    lastTag: string | null;
    lastTagDate: string | null;
    prs: ParsedPR[];
    suggestedBump: BumpType;
    suggestedVersion: string;
    currentVersion: string;
    /** The versioning scheme active for this repo. Drives the recommendation rendering. */
    versioningScheme: VersioningScheme;
    reasoning: string;
    changelogPreview: string;
    /**
     * User-facing summary previewed in the report comment's collapsible
     * "Plain-language summary" section. Same shape carried through to
     * `ReleasePlan.releaseSummary` on approval — what the bot previews is
     * what the action publishes.
     */
    summaryPreview: ReleaseSummary;
    isMonorepo: boolean;
    monorepoInfo: MonorepoInfo | null;
    /**
     * Per-package release records previewed in the report comment. Empty
     * array for single-repo. On approval, `approve.ts` re-derives this with
     * any user-supplied `pkg:bump` overrides applied and copies the result
     * into `ReleasePlan.packages` for the action to execute.
     */
    packages: PackageReleasePlan[];
    generatedAt: string;
}

/**
 * Per-package release record (M3 — per-package monorepo versioning). One of
 * these is produced for each package that has at least one attributed PR
 * since the last release. The action consumes this array to bump versions,
 * write per-package CHANGELOGs, and push per-package tags independently —
 * Changesets-style "one PR, many tags."
 *
 * `bumpType` is the conventional-commit-derived advisory bump for this
 * package's own PRs. It's authoritative for `semver` scheme; `calver` /
 * `incremental` ignore it and compute mechanically from the package's
 * `currentVersion`.
 *
 * `tagName` is pre-computed by the bot (via `packageTagName()`) so the
 * action doesn't need to know naming conventions — it just pushes the tag
 * verbatim. Default convention follows Changesets: `@scope/name@1.5.0` for
 * scoped packages, `name@1.5.0` for unscoped.
 */
export interface PackageReleasePlan {
    name: string;
    /** Directory path relative to repo root (e.g. `packages/api`). */
    path: string;
    packageJsonPath: string;
    changelogPath: string;
    currentVersion: string;
    nextVersion: string;
    bumpType: BumpType;
    prs: ParsedPR[];
    /** Markdown entry to prepend to this package's CHANGELOG.md. */
    changelogContent: string;
    tagName: string;
}

export interface ReleasePlan {
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    bumpType: BumpType;
    currentVersion: string;
    nextVersion: string;
    lastTag: string | null;
    prs: ParsedPR[];
    changelogContent: string;
    /**
     * Plain-language summary the action publishes at release time — as the
     * top section of the GitHub release body and as the "Ready to share"
     * block in the completion comment. Always set; degrades to a minimal
     * deterministic shape when the AI call fails.
     */
    releaseSummary: ReleaseSummary;
    isMonorepo: boolean;
    monorepoInfo: MonorepoInfo | null;
    /**
     * Per-package release records (M3). Empty for single-repo. Non-empty for
     * monorepos with at least one affected package — the action iterates this
     * array instead of the legacy single-version path. When non-empty,
     * `nextVersion` becomes a release-event identifier (typically the date)
     * rather than a package version.
     */
    packages: PackageReleasePlan[];
    isDraft: boolean;
    isDryRun: boolean;
    issueNumber: number;
    approvedBy: string;
    approvedAt: string;
}

export interface ReleaseResult {
    success: boolean;
    nextVersion: string;
    tagName: string;
    releaseUrl: string | null;
    prUrl: string | null;
    error: string | null;
    isDryRun: boolean;
}
