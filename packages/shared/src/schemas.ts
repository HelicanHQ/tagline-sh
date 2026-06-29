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
    'hotfix',
    'release',
]);

export const BumpTypeSchema = z.enum(['major', 'minor', 'patch', 'none']);

/**
 * Reject a version whose release core contains a zero-padded numeric component
 * (e.g. the `06` in `2026.06.0`). npm/SemVer forbid leading zeros, so such a
 * version breaks at `npm publish` — this is the trust-boundary backstop for the
 * calver `0M`/`0D` foot-gun, in case a stale bot build slips one through.
 *
 * Deliberately NOT a full `semver.valid()` check: the `incremental` scheme
 * legitimately produces bare integers (`7`), which aren't SemVer but are a
 * supported, npm-publishable shape. `ReleasePlan` carries no scheme field, so
 * we can't branch on it here — a targeted leading-zero test catches the real
 * defect without rejecting incremental versions, and needs no `semver` dep.
 */
function hasLeadingZeroComponent(version: string): boolean {
    const core = version.replace(/^v/, '').split(/[-+]/, 1)[0] ?? '';
    return core.split('.').some((part) => /^0\d/.test(part));
}

const npmSafeVersion = (schema: z.ZodString) =>
    schema.refine((v) => !hasLeadingZeroComponent(v), {
        message:
            "version has a zero-padded component (npm forbids leading zeros, e.g. '06' in " +
            "'2026.06.0'); use an unpadded calver pattern such as 'YYYY.MM.MICRO'",
    });

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

export const VersioningSchemeSchema = z.enum(['semver', 'calver', 'incremental']);

export const VersioningConfigSchema = z.object({
    scheme: VersioningSchemeSchema,
    pattern: z.string().nullable(),
});

export const ChannelTierSchema = z.enum(['stable', 'prerelease']);

export const ReleaseChannelSchema = z.object({
    branch: z.string().min(1),
    tier: ChannelTierSchema,
    suffix: z.string().min(1).nullable(),
});

export const RepoConfigSchema = z.object({
    channels: z.array(ReleaseChannelSchema).min(1),
    branches: z.object({
        production: z.string(),
        staging: z.string().nullable(),
        development: z.string().nullable(),
    }),
    preReleaseSuffix: z.object({
        staging: z.string(),
        development: z.string(),
    }),
    versioning: VersioningConfigSchema,
    releaseNotesStyle: z.string(),
    customContext: z.string(),
    rawContent: z.string(),
});

/**
 * Plain-language release notes carried alongside the technical changelog.
 * Length bounds on `highlights` (1–5) live HERE, not on the TypeScript type —
 * TS can't model array-length cleanly, but zod validates at the action's
 * trust boundary which is the load-bearing place anyway.
 */
export const ReleaseSummarySchema = z.object({
    version: z.string().min(1),
    date: z.string().min(1),
    headline: z.string().min(1),
    body: z.string().min(1),
    highlights: z.array(z.string().min(1)).min(1).max(5),
    rawMarkdown: z.string().min(1),
});

export const PackageReleasePlanSchema = z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    packageJsonPath: z.string().min(1),
    changelogPath: z.string().min(1),
    currentVersion: z.string().min(1),
    nextVersion: npmSafeVersion(z.string().min(1)),
    bumpType: BumpTypeSchema,
    // `prs` is OPTIONAL in transport. The bot strips it out before
    // workflow_dispatch (it's already baked into `changelogContent`). The
    // action never re-reads PR data, so empty-array default is safe and
    // shrinks the dispatch payload by 10–100× for large monorepos.
    prs: z.array(ParsedPRSchema).default([]),
    changelogContent: z.string(),
    tagName: z.string().min(1),
});

export const ReleasePlanSchema = z.object({
    repoOwner: z.string().min(1),
    repoName: z.string().min(1),
    baseBranch: z.string().min(1),
    bumpType: BumpTypeSchema,
    currentVersion: z.string().min(1),
    nextVersion: npmSafeVersion(z.string().min(1)),
    lastTag: z.string().nullable(),
    // OPTIONAL in transport — see PackageReleasePlanSchema.prs above. The bot
    // sends `[]` over the wire to stay under GitHub's `workflow_dispatch`
    // input size limit; the rendered `changelogContent` is the canonical
    // source from this point onward.
    prs: z.array(ParsedPRSchema).default([]),
    changelogContent: z.string(),
    // Required, not optional — the bot ALWAYS produces a summary (AI or
    // deterministic fallback). Making this nullable would let stale bot
    // builds slip a missing-summary plan past the action boundary unnoticed.
    releaseSummary: ReleaseSummarySchema,
    isMonorepo: z.boolean(),
    // OPTIONAL in transport — large monorepoInfo with `affectedPRs` per
    // package can dwarf the rest of the plan. The action doesn't read this.
    monorepoInfo: MonorepoInfoSchema.nullable().default(null),
    // Per-package plans (M3). Empty array for single-repo.
    packages: z.array(PackageReleasePlanSchema),
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
