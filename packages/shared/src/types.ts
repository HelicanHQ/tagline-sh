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
    | 'breaking';

export type BumpType = 'major' | 'minor' | 'patch' | 'none';

export type MonorepoType =
    | 'pnpm-workspaces'
    | 'npm-workspaces'
    | 'yarn-workspaces'
    | 'turborepo'
    | 'nx'
    | 'lerna'
    | 'none';

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
    releaseNotesStyle: string;
    customContext: string;
    rawContent: string;
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
    reasoning: string;
    changelogPreview: string;
    isMonorepo: boolean;
    monorepoInfo: MonorepoInfo | null;
    generatedAt: string;
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
    isMonorepo: boolean;
    monorepoInfo: MonorepoInfo | null;
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
