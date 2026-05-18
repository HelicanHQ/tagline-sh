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
function releaseBranchName(version) {
  const stripped = version.startsWith("v") ? version.slice(1) : version;
  return `release/v${stripped}`;
}
function releaseTagName(version) {
  return version.startsWith("v") ? version : `v${version}`;
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
  "breaking"
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
  releaseNotesStyle: z.string(),
  customContext: z.string(),
  rawContent: z.string()
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
  isMonorepo: z.boolean(),
  monorepoInfo: MonorepoInfoSchema.nullable(),
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
  DEFAULT_CONFIG,
  MonorepoInfoSchema,
  MonorepoTypeSchema,
  PackageInfoSchema,
  ParsedCommitSchema,
  ParsedPRSchema,
  RELEASE_WORKFLOW_FILE,
  ReleasePlanSchema,
  ReleaseResultSchema,
  RepoConfigSchema,
  aggregateBumps,
  excerpt,
  extractTickets,
  maxBump,
  parseReleasePlan,
  releaseBranchName,
  releaseTagName
};
//# sourceMappingURL=index.js.map