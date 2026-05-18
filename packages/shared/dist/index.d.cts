import { z } from 'zod';

type CommitType = 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'perf' | 'test' | 'build' | 'ci' | 'chore' | 'revert' | 'breaking' | 'hotfix' | 'release';
type BumpType = 'major' | 'minor' | 'patch' | 'none';
type MonorepoType = 'pnpm-workspaces' | 'npm-workspaces' | 'yarn-workspaces' | 'turborepo' | 'nx' | 'lerna' | 'none';
/**
 * Versioning scheme selected by the user in `.release-agent.md`. Default is
 * `semver`. `calver` requires `VersioningConfig.pattern`; `incremental` ignores
 * it. SemVer math is the only scheme that interprets `BumpType` literally —
 * CalVer is time-driven and incremental is monotonic.
 */
type VersioningScheme = 'semver' | 'calver' | 'incremental';
interface VersioningConfig {
    scheme: VersioningScheme;
    /**
     * Calver pattern template. Tokens: `YYYY`, `YY`, `0Y`, `MM`, `0M`, `DD`,
     * `0D`, `MICRO`. Anything else is treated as a literal separator. Must
     * include `MICRO` for calver schemes. Ignored for semver / incremental.
     */
    pattern: string | null;
}
interface ParsedCommit {
    type: CommitType;
    scope: string | null;
    subject: string;
    body: string | null;
    isBreaking: boolean;
    sha: string;
}
interface ParsedPR {
    number: number;
    title: string;
    url: string;
    author: string;
    mergedAt: string;
    commits: ParsedCommit[];
    tickets: string[];
    suggestedBump: BumpType;
    bodyExcerpt: string | null;
}
interface PackageInfo {
    name: string;
    path: string;
    currentVersion: string;
    packageJsonPath: string;
    changelogPath: string;
    affectedPRs: ParsedPR[];
}
interface MonorepoInfo {
    type: MonorepoType;
    packages: PackageInfo[];
    rootPackage: PackageInfo | null;
}
interface RepoConfig {
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
interface ReleaseReport {
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
    isMonorepo: boolean;
    monorepoInfo: MonorepoInfo | null;
    generatedAt: string;
}
interface ReleasePlan {
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    bumpType: BumpType;
    currentVersion: string;
    nextVersion: string;
    lastTag: string | null;
    prs: ParsedPR[];
    changelogContent: string;
    isMonorepo: boolean;
    monorepoInfo: MonorepoInfo | null;
    isDraft: boolean;
    isDryRun: boolean;
    issueNumber: number;
    approvedBy: string;
    approvedAt: string;
}
interface ReleaseResult {
    success: boolean;
    nextVersion: string;
    tagName: string;
    releaseUrl: string | null;
    prUrl: string | null;
    error: string | null;
    isDryRun: boolean;
}

/** Human-facing product name. Used in bot comments, doc headers, GitHub App name. */
declare const APP_DISPLAY_NAME = "Tagline";
/** npm package / repo identifier. */
declare const APP_PACKAGE_NAME = "tagline-sh";
/** Git identity used by the Action when committing release changes. */
declare const BOT_GIT_IDENTITY: {
    readonly name: "tagline-sh[bot]";
    readonly email: "tagline-sh[bot]@users.noreply.github.com";
};
/**
 * Commit-type → bump mapping per PLAN.md §11.
 *
 * BREAKING CHANGE in the footer or `!` after the type always wins and forces
 * `major` — that override is applied by the parser, not by this map.
 */
declare const COMMIT_TYPE_BUMP: Record<string, BumpType>;
/**
 * Numeric ordering used to compute the max bump across a set of PRs.
 * Higher value = bigger release.
 */
declare const BUMP_PRIORITY: Record<BumpType, number>;
/**
 * Default calver pattern when the user opts into calver without specifying a
 * pattern. `YYYY.0M.MICRO` matches the most common npm CalVer convention.
 */
declare const DEFAULT_CALVER_PATTERN = "YYYY.0M.MICRO";
declare const DEFAULT_VERSIONING: VersioningConfig;
declare const DEFAULT_CONFIG: RepoConfig;
/** AI configuration defaults. Users override via env vars at the bot host. */
declare const AI_DEFAULTS: {
    readonly baseUrl: "https://openrouter.ai/api/v1";
    readonly model: "openai/gpt-4o-mini";
};
/** Workflow file the bot dispatches against in the user's repo. */
declare const RELEASE_WORKFLOW_FILE = "release-agent.yml";

/**
 * Extract ticket references from text.
 *
 * Matches three families (PLAN.md §11):
 *   - JIRA / Linear style: `PROJ-123`, `ENG-456` (uppercase prefix)
 *   - Linear lowercase variant: `eng-123` (case-insensitive prefix)
 *   - GitHub Issues: `#42`
 *
 * The order matters: we run JIRA first (uppercase) so `PROJ-123` is captured as
 * `PROJ-123` rather than being matched twice. Results are deduplicated while
 * preserving first-occurrence order.
 *
 * No external API calls — pure regex on the supplied text.
 */
declare function extractTickets(text: string): string[];
/**
 * Prefix every release branch shares (`release/v…`). Used by readers that need
 * to recognize bot-authored release PRs without depending on a specific version
 * string.
 */
declare const RELEASE_BRANCH_PREFIX = "release/v";
/** Branch name used for the release PR. e.g. `release/v1.2.3` */
declare function releaseBranchName(version: string): string;
/**
 * Returns true if `headRef` looks like one of our own release branches
 * (`release/v1.2.3`, `release/v2026.05.0-rc.0`, etc.). Used to filter the
 * previous release PR out of the next release's changelog — its body is the
 * old changelog and would otherwise leak hundreds of `#N` refs as tickets.
 */
declare function isReleaseBranch(headRef: string): boolean;
/** Tag name written by the action. e.g. `v1.2.3` */
declare function releaseTagName(version: string): string;
/** Returns the higher-impact of two bumps. `major > minor > patch > none`. */
declare function maxBump(a: BumpType, b: BumpType): BumpType;
/** Folds an array of bumps to the highest impact present. */
declare function aggregateBumps(bumps: readonly BumpType[]): BumpType;
/** Truncate a PR body to the first N chars (default 500) preserving word boundaries. */
declare function excerpt(text: string | null | undefined, maxLen?: number): string | null;

declare const CommitTypeSchema: z.ZodEnum<["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert", "breaking", "hotfix", "release"]>;
declare const BumpTypeSchema: z.ZodEnum<["major", "minor", "patch", "none"]>;
declare const MonorepoTypeSchema: z.ZodEnum<["pnpm-workspaces", "npm-workspaces", "yarn-workspaces", "turborepo", "nx", "lerna", "none"]>;
declare const ParsedCommitSchema: z.ZodObject<{
    type: z.ZodEnum<["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert", "breaking", "hotfix", "release"]>;
    scope: z.ZodNullable<z.ZodString>;
    subject: z.ZodString;
    body: z.ZodNullable<z.ZodString>;
    isBreaking: z.ZodBoolean;
    sha: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
    scope: string | null;
    subject: string;
    body: string | null;
    isBreaking: boolean;
    sha: string;
}, {
    type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
    scope: string | null;
    subject: string;
    body: string | null;
    isBreaking: boolean;
    sha: string;
}>;
declare const ParsedPRSchema: z.ZodObject<{
    number: z.ZodNumber;
    title: z.ZodString;
    url: z.ZodString;
    author: z.ZodString;
    mergedAt: z.ZodString;
    commits: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert", "breaking", "hotfix", "release"]>;
        scope: z.ZodNullable<z.ZodString>;
        subject: z.ZodString;
        body: z.ZodNullable<z.ZodString>;
        isBreaking: z.ZodBoolean;
        sha: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
        scope: string | null;
        subject: string;
        body: string | null;
        isBreaking: boolean;
        sha: string;
    }, {
        type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
        scope: string | null;
        subject: string;
        body: string | null;
        isBreaking: boolean;
        sha: string;
    }>, "many">;
    tickets: z.ZodArray<z.ZodString, "many">;
    suggestedBump: z.ZodEnum<["major", "minor", "patch", "none"]>;
    bodyExcerpt: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    number: number;
    title: string;
    url: string;
    author: string;
    mergedAt: string;
    commits: {
        type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
        scope: string | null;
        subject: string;
        body: string | null;
        isBreaking: boolean;
        sha: string;
    }[];
    tickets: string[];
    suggestedBump: "major" | "minor" | "patch" | "none";
    bodyExcerpt: string | null;
}, {
    number: number;
    title: string;
    url: string;
    author: string;
    mergedAt: string;
    commits: {
        type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
        scope: string | null;
        subject: string;
        body: string | null;
        isBreaking: boolean;
        sha: string;
    }[];
    tickets: string[];
    suggestedBump: "major" | "minor" | "patch" | "none";
    bodyExcerpt: string | null;
}>;
declare const PackageInfoSchema: z.ZodType<{
    name: string;
    path: string;
    currentVersion: string;
    packageJsonPath: string;
    changelogPath: string;
    affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
}>;
declare const MonorepoInfoSchema: z.ZodObject<{
    type: z.ZodEnum<["pnpm-workspaces", "npm-workspaces", "yarn-workspaces", "turborepo", "nx", "lerna", "none"]>;
    packages: z.ZodArray<z.ZodType<{
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    }, z.ZodTypeDef, {
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    }>, "many">;
    rootPackage: z.ZodNullable<z.ZodType<{
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    }, z.ZodTypeDef, {
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "none" | "pnpm-workspaces" | "npm-workspaces" | "yarn-workspaces" | "turborepo" | "nx" | "lerna";
    packages: {
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    }[];
    rootPackage: {
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    } | null;
}, {
    type: "none" | "pnpm-workspaces" | "npm-workspaces" | "yarn-workspaces" | "turborepo" | "nx" | "lerna";
    packages: {
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    }[];
    rootPackage: {
        name: string;
        path: string;
        currentVersion: string;
        packageJsonPath: string;
        changelogPath: string;
        affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
    } | null;
}>;
declare const VersioningSchemeSchema: z.ZodEnum<["semver", "calver", "incremental"]>;
declare const VersioningConfigSchema: z.ZodObject<{
    scheme: z.ZodEnum<["semver", "calver", "incremental"]>;
    pattern: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    scheme: "semver" | "calver" | "incremental";
    pattern: string | null;
}, {
    scheme: "semver" | "calver" | "incremental";
    pattern: string | null;
}>;
declare const RepoConfigSchema: z.ZodObject<{
    branches: z.ZodObject<{
        production: z.ZodString;
        staging: z.ZodNullable<z.ZodString>;
        development: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        staging: string | null;
        production: string;
        development: string | null;
    }, {
        staging: string | null;
        production: string;
        development: string | null;
    }>;
    preReleaseSuffix: z.ZodObject<{
        staging: z.ZodString;
        development: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        staging: string;
        development: string;
    }, {
        staging: string;
        development: string;
    }>;
    versioning: z.ZodObject<{
        scheme: z.ZodEnum<["semver", "calver", "incremental"]>;
        pattern: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        scheme: "semver" | "calver" | "incremental";
        pattern: string | null;
    }, {
        scheme: "semver" | "calver" | "incremental";
        pattern: string | null;
    }>;
    releaseNotesStyle: z.ZodString;
    customContext: z.ZodString;
    rawContent: z.ZodString;
}, "strip", z.ZodTypeAny, {
    branches: {
        staging: string | null;
        production: string;
        development: string | null;
    };
    preReleaseSuffix: {
        staging: string;
        development: string;
    };
    versioning: {
        scheme: "semver" | "calver" | "incremental";
        pattern: string | null;
    };
    releaseNotesStyle: string;
    customContext: string;
    rawContent: string;
}, {
    branches: {
        staging: string | null;
        production: string;
        development: string | null;
    };
    preReleaseSuffix: {
        staging: string;
        development: string;
    };
    versioning: {
        scheme: "semver" | "calver" | "incremental";
        pattern: string | null;
    };
    releaseNotesStyle: string;
    customContext: string;
    rawContent: string;
}>;
declare const ReleasePlanSchema: z.ZodObject<{
    repoOwner: z.ZodString;
    repoName: z.ZodString;
    baseBranch: z.ZodString;
    bumpType: z.ZodEnum<["major", "minor", "patch", "none"]>;
    currentVersion: z.ZodString;
    nextVersion: z.ZodString;
    lastTag: z.ZodNullable<z.ZodString>;
    prs: z.ZodArray<z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodString;
        url: z.ZodString;
        author: z.ZodString;
        mergedAt: z.ZodString;
        commits: z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert", "breaking", "hotfix", "release"]>;
            scope: z.ZodNullable<z.ZodString>;
            subject: z.ZodString;
            body: z.ZodNullable<z.ZodString>;
            isBreaking: z.ZodBoolean;
            sha: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
            scope: string | null;
            subject: string;
            body: string | null;
            isBreaking: boolean;
            sha: string;
        }, {
            type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
            scope: string | null;
            subject: string;
            body: string | null;
            isBreaking: boolean;
            sha: string;
        }>, "many">;
        tickets: z.ZodArray<z.ZodString, "many">;
        suggestedBump: z.ZodEnum<["major", "minor", "patch", "none"]>;
        bodyExcerpt: z.ZodNullable<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        number: number;
        title: string;
        url: string;
        author: string;
        mergedAt: string;
        commits: {
            type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
            scope: string | null;
            subject: string;
            body: string | null;
            isBreaking: boolean;
            sha: string;
        }[];
        tickets: string[];
        suggestedBump: "major" | "minor" | "patch" | "none";
        bodyExcerpt: string | null;
    }, {
        number: number;
        title: string;
        url: string;
        author: string;
        mergedAt: string;
        commits: {
            type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
            scope: string | null;
            subject: string;
            body: string | null;
            isBreaking: boolean;
            sha: string;
        }[];
        tickets: string[];
        suggestedBump: "major" | "minor" | "patch" | "none";
        bodyExcerpt: string | null;
    }>, "many">;
    changelogContent: z.ZodString;
    isMonorepo: z.ZodBoolean;
    monorepoInfo: z.ZodNullable<z.ZodObject<{
        type: z.ZodEnum<["pnpm-workspaces", "npm-workspaces", "yarn-workspaces", "turborepo", "nx", "lerna", "none"]>;
        packages: z.ZodArray<z.ZodType<{
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }, z.ZodTypeDef, {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }>, "many">;
        rootPackage: z.ZodNullable<z.ZodType<{
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }, z.ZodTypeDef, {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }>>;
    }, "strip", z.ZodTypeAny, {
        type: "none" | "pnpm-workspaces" | "npm-workspaces" | "yarn-workspaces" | "turborepo" | "nx" | "lerna";
        packages: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }[];
        rootPackage: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        } | null;
    }, {
        type: "none" | "pnpm-workspaces" | "npm-workspaces" | "yarn-workspaces" | "turborepo" | "nx" | "lerna";
        packages: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }[];
        rootPackage: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        } | null;
    }>>;
    isDraft: z.ZodBoolean;
    isDryRun: z.ZodBoolean;
    issueNumber: z.ZodNumber;
    approvedBy: z.ZodString;
    approvedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    currentVersion: string;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    bumpType: "major" | "minor" | "patch" | "none";
    nextVersion: string;
    lastTag: string | null;
    prs: {
        number: number;
        title: string;
        url: string;
        author: string;
        mergedAt: string;
        commits: {
            type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
            scope: string | null;
            subject: string;
            body: string | null;
            isBreaking: boolean;
            sha: string;
        }[];
        tickets: string[];
        suggestedBump: "major" | "minor" | "patch" | "none";
        bodyExcerpt: string | null;
    }[];
    changelogContent: string;
    isMonorepo: boolean;
    monorepoInfo: {
        type: "none" | "pnpm-workspaces" | "npm-workspaces" | "yarn-workspaces" | "turborepo" | "nx" | "lerna";
        packages: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }[];
        rootPackage: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        } | null;
    } | null;
    isDraft: boolean;
    isDryRun: boolean;
    issueNumber: number;
    approvedBy: string;
    approvedAt: string;
}, {
    currentVersion: string;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    bumpType: "major" | "minor" | "patch" | "none";
    nextVersion: string;
    lastTag: string | null;
    prs: {
        number: number;
        title: string;
        url: string;
        author: string;
        mergedAt: string;
        commits: {
            type: "feat" | "fix" | "docs" | "style" | "refactor" | "perf" | "test" | "build" | "ci" | "chore" | "revert" | "breaking" | "hotfix" | "release";
            scope: string | null;
            subject: string;
            body: string | null;
            isBreaking: boolean;
            sha: string;
        }[];
        tickets: string[];
        suggestedBump: "major" | "minor" | "patch" | "none";
        bodyExcerpt: string | null;
    }[];
    changelogContent: string;
    isMonorepo: boolean;
    monorepoInfo: {
        type: "none" | "pnpm-workspaces" | "npm-workspaces" | "yarn-workspaces" | "turborepo" | "nx" | "lerna";
        packages: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        }[];
        rootPackage: {
            name: string;
            path: string;
            currentVersion: string;
            packageJsonPath: string;
            changelogPath: string;
            affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
        } | null;
    } | null;
    isDraft: boolean;
    isDryRun: boolean;
    issueNumber: number;
    approvedBy: string;
    approvedAt: string;
}>;
declare const ReleaseResultSchema: z.ZodObject<{
    success: z.ZodBoolean;
    nextVersion: z.ZodString;
    tagName: z.ZodString;
    releaseUrl: z.ZodNullable<z.ZodString>;
    prUrl: z.ZodNullable<z.ZodString>;
    error: z.ZodNullable<z.ZodString>;
    isDryRun: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    nextVersion: string;
    isDryRun: boolean;
    success: boolean;
    tagName: string;
    releaseUrl: string | null;
    prUrl: string | null;
    error: string | null;
}, {
    nextVersion: string;
    isDryRun: boolean;
    success: boolean;
    tagName: string;
    releaseUrl: string | null;
    prUrl: string | null;
    error: string | null;
}>;
/** Parse a JSON-encoded ReleasePlan, throwing a typed ZodError on malformed input. */
declare function parseReleasePlan(json: string): z.infer<typeof ReleasePlanSchema>;

export { AI_DEFAULTS, APP_DISPLAY_NAME, APP_PACKAGE_NAME, BOT_GIT_IDENTITY, BUMP_PRIORITY, type BumpType, BumpTypeSchema, COMMIT_TYPE_BUMP, type CommitType, CommitTypeSchema, DEFAULT_CALVER_PATTERN, DEFAULT_CONFIG, DEFAULT_VERSIONING, type MonorepoInfo, MonorepoInfoSchema, type MonorepoType, MonorepoTypeSchema, type PackageInfo, PackageInfoSchema, type ParsedCommit, ParsedCommitSchema, type ParsedPR, ParsedPRSchema, RELEASE_BRANCH_PREFIX, RELEASE_WORKFLOW_FILE, type ReleasePlan, ReleasePlanSchema, type ReleaseReport, type ReleaseResult, ReleaseResultSchema, type RepoConfig, RepoConfigSchema, type VersioningConfig, VersioningConfigSchema, type VersioningScheme, VersioningSchemeSchema, aggregateBumps, excerpt, extractTickets, isReleaseBranch, maxBump, parseReleasePlan, releaseBranchName, releaseTagName };
