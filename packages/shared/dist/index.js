// src/constants.ts
var APP_DISPLAY_NAME = "Tagline";
var APP_PACKAGE_NAME = "tagline-sh";
var BOT_GIT_IDENTITY = {
  name: `${APP_PACKAGE_NAME}[bot]`,
  email: `${APP_PACKAGE_NAME}[bot]@users.noreply.github.com`
};
var COMMIT_TYPE_BUMP = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
  revert: "patch",
  docs: "none",
  style: "none",
  refactor: "none",
  test: "none",
  build: "none",
  ci: "none",
  chore: "none"
};
var BUMP_PRIORITY = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3
};
var DEFAULT_CALVER_PATTERN = "YYYY.0M.MICRO";
var DEFAULT_VERSIONING = {
  scheme: "semver",
  pattern: null
};
var DEFAULT_CONFIG = {
  branches: {
    production: "main",
    staging: "staging",
    development: "develop"
  },
  preReleaseSuffix: {
    staging: "rc",
    development: "alpha"
  },
  versioning: DEFAULT_VERSIONING,
  releaseNotesStyle: "",
  customContext: "",
  rawContent: ""
};
var AI_DEFAULTS = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini"
};
var RELEASE_WORKFLOW_FILE = "release-agent.yml";

// src/utils.ts
function extractTickets(text) {
  if (!text) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const push = (raw) => {
    const normalized = raw.trim();
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  const ghRe = /#\d+/g;
  for (const match of text.matchAll(ghRe)) push(match[0]);
  const projRe = /\b[A-Za-z][A-Za-z0-9]+-\d+\b/g;
  for (const match of text.matchAll(projRe)) push(match[0]);
  return out;
}
var RELEASE_BRANCH_PREFIX = "release/v";
function releaseBranchName(version) {
  const stripped = version.startsWith("v") ? version.slice(1) : version;
  return `${RELEASE_BRANCH_PREFIX}${stripped}`;
}
function isReleaseBranch(headRef) {
  return headRef.startsWith(RELEASE_BRANCH_PREFIX);
}
function releaseTagName(version) {
  return version.startsWith("v") ? version : `v${version}`;
}
function packageTagName(packageName, version) {
  const stripped = version.startsWith("v") ? version.slice(1) : version;
  return `${packageName}@${stripped}`;
}
function maxBump(a, b) {
  return BUMP_PRIORITY[a] >= BUMP_PRIORITY[b] ? a : b;
}
function aggregateBumps(bumps) {
  let acc = "none";
  for (const b of bumps) acc = maxBump(acc, b);
  return acc;
}
function excerpt(text, maxLen = 500) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLen) return trimmed;
  const slice = trimmed.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice) + "\u2026";
}
function buildSummaryMarkdown(summary) {
  const version = summary.version.startsWith("v") ? summary.version : `v${summary.version}`;
  return [
    `## What's new in ${version} \xB7 ${summary.date}`,
    "",
    summary.headline,
    "",
    summary.body,
    "",
    summary.highlights.map((h) => `- ${h}`).join("\n")
  ].join("\n");
}
function formatSummaryDate(d) {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
}
function restampSummary(summary, version, now) {
  const versionLabel = version.startsWith("v") ? version.slice(1) : version;
  const intermediate = {
    ...summary,
    version: versionLabel,
    date: formatSummaryDate(now),
    rawMarkdown: ""
  };
  return { ...intermediate, rawMarkdown: buildSummaryMarkdown(intermediate) };
}

// src/schemas.ts
import { z } from "zod";
var CommitTypeSchema = z.enum([
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
  "breaking",
  "hotfix",
  "release"
]);
var BumpTypeSchema = z.enum(["major", "minor", "patch", "none"]);
var MonorepoTypeSchema = z.enum([
  "pnpm-workspaces",
  "npm-workspaces",
  "yarn-workspaces",
  "turborepo",
  "nx",
  "lerna",
  "none"
]);
var ParsedCommitSchema = z.object({
  type: CommitTypeSchema,
  scope: z.string().nullable(),
  subject: z.string(),
  body: z.string().nullable(),
  isBreaking: z.boolean(),
  sha: z.string()
});
var ParsedPRSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  author: z.string(),
  mergedAt: z.string(),
  commits: z.array(ParsedCommitSchema),
  tickets: z.array(z.string()),
  suggestedBump: BumpTypeSchema,
  bodyExcerpt: z.string().nullable()
});
var PackageInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  currentVersion: z.string(),
  packageJsonPath: z.string(),
  changelogPath: z.string(),
  affectedPRs: z.array(ParsedPRSchema)
});
var MonorepoInfoSchema = z.object({
  type: MonorepoTypeSchema,
  packages: z.array(PackageInfoSchema),
  rootPackage: PackageInfoSchema.nullable()
});
var VersioningSchemeSchema = z.enum(["semver", "calver", "incremental"]);
var VersioningConfigSchema = z.object({
  scheme: VersioningSchemeSchema,
  pattern: z.string().nullable()
});
var RepoConfigSchema = z.object({
  branches: z.object({
    production: z.string(),
    staging: z.string().nullable(),
    development: z.string().nullable()
  }),
  preReleaseSuffix: z.object({
    staging: z.string(),
    development: z.string()
  }),
  versioning: VersioningConfigSchema,
  releaseNotesStyle: z.string(),
  customContext: z.string(),
  rawContent: z.string()
});
var ReleaseSummarySchema = z.object({
  version: z.string().min(1),
  date: z.string().min(1),
  headline: z.string().min(1),
  body: z.string().min(1),
  highlights: z.array(z.string().min(1)).min(1).max(5),
  rawMarkdown: z.string().min(1)
});
var PackageReleasePlanSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  packageJsonPath: z.string().min(1),
  changelogPath: z.string().min(1),
  currentVersion: z.string().min(1),
  nextVersion: z.string().min(1),
  bumpType: BumpTypeSchema,
  prs: z.array(ParsedPRSchema),
  changelogContent: z.string(),
  tagName: z.string().min(1)
});
var ReleasePlanSchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  baseBranch: z.string().min(1),
  bumpType: BumpTypeSchema,
  currentVersion: z.string().min(1),
  nextVersion: z.string().min(1),
  lastTag: z.string().nullable(),
  prs: z.array(ParsedPRSchema),
  changelogContent: z.string(),
  // Required, not optional — the bot ALWAYS produces a summary (AI or
  // deterministic fallback). Making this nullable would let stale bot
  // builds slip a missing-summary plan past the action boundary unnoticed.
  releaseSummary: ReleaseSummarySchema,
  isMonorepo: z.boolean(),
  monorepoInfo: MonorepoInfoSchema.nullable(),
  // Per-package plans (M3). Empty array for single-repo.
  packages: z.array(PackageReleasePlanSchema),
  isDraft: z.boolean(),
  isDryRun: z.boolean(),
  issueNumber: z.number().int().nonnegative(),
  approvedBy: z.string(),
  approvedAt: z.string()
});
var ReleaseResultSchema = z.object({
  success: z.boolean(),
  nextVersion: z.string(),
  tagName: z.string(),
  releaseUrl: z.string().nullable(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  isDryRun: z.boolean()
});
function parseReleasePlan(json) {
  const data = JSON.parse(json);
  return ReleasePlanSchema.parse(data);
}
export {
  AI_DEFAULTS,
  APP_DISPLAY_NAME,
  APP_PACKAGE_NAME,
  BOT_GIT_IDENTITY,
  BUMP_PRIORITY,
  BumpTypeSchema,
  COMMIT_TYPE_BUMP,
  CommitTypeSchema,
  DEFAULT_CALVER_PATTERN,
  DEFAULT_CONFIG,
  DEFAULT_VERSIONING,
  MonorepoInfoSchema,
  MonorepoTypeSchema,
  PackageInfoSchema,
  PackageReleasePlanSchema,
  ParsedCommitSchema,
  ParsedPRSchema,
  RELEASE_BRANCH_PREFIX,
  RELEASE_WORKFLOW_FILE,
  ReleasePlanSchema,
  ReleaseResultSchema,
  ReleaseSummarySchema,
  RepoConfigSchema,
  VersioningConfigSchema,
  VersioningSchemeSchema,
  aggregateBumps,
  buildSummaryMarkdown,
  excerpt,
  extractTickets,
  formatSummaryDate,
  isReleaseBranch,
  maxBump,
  packageTagName,
  parseReleasePlan,
  releaseBranchName,
  releaseTagName,
  restampSummary
};
//# sourceMappingURL=index.js.map