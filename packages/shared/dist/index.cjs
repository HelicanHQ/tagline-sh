"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  AI_DEFAULTS: () => AI_DEFAULTS,
  APP_DISPLAY_NAME: () => APP_DISPLAY_NAME,
  APP_PACKAGE_NAME: () => APP_PACKAGE_NAME,
  BOT_GIT_IDENTITY: () => BOT_GIT_IDENTITY,
  BUMP_PRIORITY: () => BUMP_PRIORITY,
  BumpTypeSchema: () => BumpTypeSchema,
  COMMIT_TYPE_BUMP: () => COMMIT_TYPE_BUMP,
  CommitTypeSchema: () => CommitTypeSchema,
  DEFAULT_CALVER_PATTERN: () => DEFAULT_CALVER_PATTERN,
  DEFAULT_CONFIG: () => DEFAULT_CONFIG,
  DEFAULT_VERSIONING: () => DEFAULT_VERSIONING,
  MonorepoInfoSchema: () => MonorepoInfoSchema,
  MonorepoTypeSchema: () => MonorepoTypeSchema,
  PackageInfoSchema: () => PackageInfoSchema,
  PackageReleasePlanSchema: () => PackageReleasePlanSchema,
  ParsedCommitSchema: () => ParsedCommitSchema,
  ParsedPRSchema: () => ParsedPRSchema,
  RELEASE_BRANCH_PREFIX: () => RELEASE_BRANCH_PREFIX,
  RELEASE_WORKFLOW_FILE: () => RELEASE_WORKFLOW_FILE,
  ReleasePlanSchema: () => ReleasePlanSchema,
  ReleaseResultSchema: () => ReleaseResultSchema,
  ReleaseSummarySchema: () => ReleaseSummarySchema,
  RepoConfigSchema: () => RepoConfigSchema,
  VersioningConfigSchema: () => VersioningConfigSchema,
  VersioningSchemeSchema: () => VersioningSchemeSchema,
  aggregateBumps: () => aggregateBumps,
  buildSummaryMarkdown: () => buildSummaryMarkdown,
  excerpt: () => excerpt,
  extractTickets: () => extractTickets,
  formatSummaryDate: () => formatSummaryDate,
  isReleaseBranch: () => isReleaseBranch,
  maxBump: () => maxBump,
  packageTagName: () => packageTagName,
  parseReleasePlan: () => parseReleasePlan,
  releaseBranchName: () => releaseBranchName,
  releaseTagName: () => releaseTagName,
  restampSummary: () => restampSummary
});
module.exports = __toCommonJS(index_exports);

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
  model: "google/gemini-3.1-flash-lite-preview"
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
var import_zod = require("zod");
var CommitTypeSchema = import_zod.z.enum([
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
var BumpTypeSchema = import_zod.z.enum(["major", "minor", "patch", "none"]);
var MonorepoTypeSchema = import_zod.z.enum([
  "pnpm-workspaces",
  "npm-workspaces",
  "yarn-workspaces",
  "turborepo",
  "nx",
  "lerna",
  "none"
]);
var ParsedCommitSchema = import_zod.z.object({
  type: CommitTypeSchema,
  scope: import_zod.z.string().nullable(),
  subject: import_zod.z.string(),
  body: import_zod.z.string().nullable(),
  isBreaking: import_zod.z.boolean(),
  sha: import_zod.z.string()
});
var ParsedPRSchema = import_zod.z.object({
  number: import_zod.z.number().int().positive(),
  title: import_zod.z.string(),
  url: import_zod.z.string().url(),
  author: import_zod.z.string(),
  mergedAt: import_zod.z.string(),
  commits: import_zod.z.array(ParsedCommitSchema),
  tickets: import_zod.z.array(import_zod.z.string()),
  suggestedBump: BumpTypeSchema,
  bodyExcerpt: import_zod.z.string().nullable()
});
var PackageInfoSchema = import_zod.z.object({
  name: import_zod.z.string(),
  path: import_zod.z.string(),
  currentVersion: import_zod.z.string(),
  packageJsonPath: import_zod.z.string(),
  changelogPath: import_zod.z.string(),
  affectedPRs: import_zod.z.array(ParsedPRSchema)
});
var MonorepoInfoSchema = import_zod.z.object({
  type: MonorepoTypeSchema,
  packages: import_zod.z.array(PackageInfoSchema),
  rootPackage: PackageInfoSchema.nullable()
});
var VersioningSchemeSchema = import_zod.z.enum(["semver", "calver", "incremental"]);
var VersioningConfigSchema = import_zod.z.object({
  scheme: VersioningSchemeSchema,
  pattern: import_zod.z.string().nullable()
});
var RepoConfigSchema = import_zod.z.object({
  branches: import_zod.z.object({
    production: import_zod.z.string(),
    staging: import_zod.z.string().nullable(),
    development: import_zod.z.string().nullable()
  }),
  preReleaseSuffix: import_zod.z.object({
    staging: import_zod.z.string(),
    development: import_zod.z.string()
  }),
  versioning: VersioningConfigSchema,
  releaseNotesStyle: import_zod.z.string(),
  customContext: import_zod.z.string(),
  rawContent: import_zod.z.string()
});
var ReleaseSummarySchema = import_zod.z.object({
  version: import_zod.z.string().min(1),
  date: import_zod.z.string().min(1),
  headline: import_zod.z.string().min(1),
  body: import_zod.z.string().min(1),
  highlights: import_zod.z.array(import_zod.z.string().min(1)).min(1).max(5),
  rawMarkdown: import_zod.z.string().min(1)
});
var PackageReleasePlanSchema = import_zod.z.object({
  name: import_zod.z.string().min(1),
  path: import_zod.z.string().min(1),
  packageJsonPath: import_zod.z.string().min(1),
  changelogPath: import_zod.z.string().min(1),
  currentVersion: import_zod.z.string().min(1),
  nextVersion: import_zod.z.string().min(1),
  bumpType: BumpTypeSchema,
  // `prs` is OPTIONAL in transport. The bot strips it out before
  // workflow_dispatch (it's already baked into `changelogContent`). The
  // action never re-reads PR data, so empty-array default is safe and
  // shrinks the dispatch payload by 10–100× for large monorepos.
  prs: import_zod.z.array(ParsedPRSchema).default([]),
  changelogContent: import_zod.z.string(),
  tagName: import_zod.z.string().min(1)
});
var ReleasePlanSchema = import_zod.z.object({
  repoOwner: import_zod.z.string().min(1),
  repoName: import_zod.z.string().min(1),
  baseBranch: import_zod.z.string().min(1),
  bumpType: BumpTypeSchema,
  currentVersion: import_zod.z.string().min(1),
  nextVersion: import_zod.z.string().min(1),
  lastTag: import_zod.z.string().nullable(),
  // OPTIONAL in transport — see PackageReleasePlanSchema.prs above. The bot
  // sends `[]` over the wire to stay under GitHub's `workflow_dispatch`
  // input size limit; the rendered `changelogContent` is the canonical
  // source from this point onward.
  prs: import_zod.z.array(ParsedPRSchema).default([]),
  changelogContent: import_zod.z.string(),
  // Required, not optional — the bot ALWAYS produces a summary (AI or
  // deterministic fallback). Making this nullable would let stale bot
  // builds slip a missing-summary plan past the action boundary unnoticed.
  releaseSummary: ReleaseSummarySchema,
  isMonorepo: import_zod.z.boolean(),
  // OPTIONAL in transport — large monorepoInfo with `affectedPRs` per
  // package can dwarf the rest of the plan. The action doesn't read this.
  monorepoInfo: MonorepoInfoSchema.nullable().default(null),
  // Per-package plans (M3). Empty array for single-repo.
  packages: import_zod.z.array(PackageReleasePlanSchema),
  isDraft: import_zod.z.boolean(),
  isDryRun: import_zod.z.boolean(),
  issueNumber: import_zod.z.number().int().nonnegative(),
  approvedBy: import_zod.z.string(),
  approvedAt: import_zod.z.string()
});
var ReleaseResultSchema = import_zod.z.object({
  success: import_zod.z.boolean(),
  nextVersion: import_zod.z.string(),
  tagName: import_zod.z.string(),
  releaseUrl: import_zod.z.string().nullable(),
  prUrl: import_zod.z.string().nullable(),
  error: import_zod.z.string().nullable(),
  isDryRun: import_zod.z.boolean()
});
function parseReleasePlan(json) {
  const data = JSON.parse(json);
  return ReleasePlanSchema.parse(data);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
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
});
//# sourceMappingURL=index.cjs.map