import { z } from 'zod';

// Zod schemas mirror types.ts. The action uses these at the trust boundary
// (parsing the JSON `release_plan` input) to fail loudly on malformed payloads
// rather than silently producing a corrupt release.

export const CommitTypeSchema = z.enum([
    'feat',
    'fix',
    'docs',
    'style',
    'refactor',
    'perf',
    'test',
    'build',
    'ci',
    'chore',
    'revert',
    'breaking',
]);

export const BumpTypeSchema = z.enum(['major', 'minor', 'patch', 'none']);

export const MonorepoTypeSchema = z.enum([
    'pnpm-workspaces',
    'npm-workspaces',
    'yarn-workspaces',
    'turborepo',
    'nx',
    'lerna',
    'none',
]);

export const ParsedCommitSchema = z.object({
    type: CommitTypeSchema,
    scope: z.string().nullable(),
    subject: z.string(),
    body: z.string().nullable(),
    isBreaking: z.boolean(),
    sha: z.string(),
});

export const ParsedPRSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    author: z.string(),
    mergedAt: z.string(),
    commits: z.array(ParsedCommitSchema),
    tickets: z.array(z.string()),
    suggestedBump: BumpTypeSchema,
    bodyExcerpt: z.string().nullable(),
});

export const PackageInfoSchema: z.ZodType<{
    name: string;
    path: string;
    currentVersion: string;
    packageJsonPath: string;
    changelogPath: string;
    affectedPRs: Array<z.infer<typeof ParsedPRSchema>>;
}> = z.object({
    name: z.string(),
    path: z.string(),
    currentVersion: z.string(),
    packageJsonPath: z.string(),
    changelogPath: z.string(),
    affectedPRs: z.array(ParsedPRSchema),
});

export const MonorepoInfoSchema = z.object({
    type: MonorepoTypeSchema,
    packages: z.array(PackageInfoSchema),
    rootPackage: PackageInfoSchema.nullable(),
});

export const RepoConfigSchema = z.object({
    branches: z.object({
        production: z.string(),
        staging: z.string().nullable(),
        development: z.string().nullable(),
    }),
    preReleaseSuffix: z.object({
        staging: z.string(),
        development: z.string(),
    }),
    releaseNotesStyle: z.string(),
    customContext: z.string(),
    rawContent: z.string(),
});

export const ReleasePlanSchema = z.object({
    repoOwner: z.string().min(1),
    repoName: z.string().min(1),
    baseBranch: z.string().min(1),
    bumpType: BumpTypeSchema,
    currentVersion: z.string().min(1),
    nextVersion: z.string().min(1),
    lastTag: z.string().nullable(),
    prs: z.array(ParsedPRSchema),
    changelogContent: z.string(),
    isMonorepo: z.boolean(),
    monorepoInfo: MonorepoInfoSchema.nullable(),
    isDraft: z.boolean(),
    isDryRun: z.boolean(),
    issueNumber: z.number().int().nonnegative(),
    approvedBy: z.string(),
    approvedAt: z.string(),
});

export const ReleaseResultSchema = z.object({
    success: z.boolean(),
    nextVersion: z.string(),
    tagName: z.string(),
    releaseUrl: z.string().nullable(),
    prUrl: z.string().nullable(),
    error: z.string().nullable(),
    isDryRun: z.boolean(),
});

/** Parse a JSON-encoded ReleasePlan, throwing a typed ZodError on malformed input. */
export function parseReleasePlan(json: string): z.infer<typeof ReleasePlanSchema> {
    const data: unknown = JSON.parse(json);
    return ReleasePlanSchema.parse(data);
}
