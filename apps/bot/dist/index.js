// src/handlers/issue-comment.ts
import { APP_DISPLAY_NAME as APP_DISPLAY_NAME2 } from "@tagline-sh/shared";

// src/services/commit-parser.ts
import {
  aggregateBumps,
  excerpt,
  extractTickets,
  COMMIT_TYPE_BUMP
} from "@tagline-sh/shared";
var HEADER_RE = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<subject>.+)$/;
var BREAKING_FOOTER_RE = /^BREAKING[- ]CHANGE:\s*(.+)$/m;
var KNOWN_TYPES = /* @__PURE__ */ new Set([
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
function parseCommit(sha, message) {
  if (!message) return null;
  const lines = message.split("\n");
  const header = (lines[0] ?? "").trim();
  const match = HEADER_RE.exec(header);
  if (!match || !match.groups) return null;
  const rawType = match.groups["type"].toLowerCase();
  const scope = match.groups["scope"]?.trim() || null;
  const subject = match.groups["subject"].trim();
  const bang = Boolean(match.groups["bang"]);
  const body = lines.slice(1).join("\n").trim() || null;
  const breakingFromFooter = BREAKING_FOOTER_RE.test(message);
  const isBreaking = bang || breakingFromFooter;
  const type = KNOWN_TYPES.has(rawType) ? rawType : "chore";
  return { type, scope, subject, body, isBreaking, sha };
}
function commitBump(commit) {
  if (commit.isBreaking) return "major";
  return COMMIT_TYPE_BUMP[commit.type] ?? "none";
}
function parsePR(summary, commits) {
  const parsedCommits = [];
  const failures = [];
  for (const c of commits) {
    const parsed = parseCommit(c.sha, c.message);
    if (parsed) {
      parsedCommits.push(parsed);
    } else {
      failures.push({ sha: c.sha, message: c.message, reason: "no-header-match" });
    }
  }
  let nonConformant = false;
  if (parsedCommits.length === 0) {
    nonConformant = true;
    const fromTitle = parseCommit(`pr-${summary.number}`, summary.title);
    if (fromTitle) {
      parsedCommits.push(fromTitle);
    } else {
      parsedCommits.push({
        type: "chore",
        scope: null,
        subject: summary.title,
        body: null,
        isBreaking: false,
        sha: `pr-${summary.number}`
      });
    }
  }
  const ticketSource = [summary.title, summary.body ?? ""].join("\n");
  const tickets = extractTickets(ticketSource);
  const suggestedBump = aggregateBumps(parsedCommits.map(commitBump));
  const pr = {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    author: summary.author,
    mergedAt: summary.mergedAt,
    commits: parsedCommits,
    tickets,
    suggestedBump,
    bodyExcerpt: excerpt(summary.body)
  };
  return { pr, nonConformant, parseFailures: failures };
}
function aggregatePRBumps(prs) {
  return aggregateBumps(prs.map((p) => p.suggestedBump));
}

// src/services/version-calculator.ts
import semver from "semver";
function calculateNextVersion(currentVersion, bumpType, branch, config) {
  if (bumpType === "none") return currentVersion;
  const cleaned = currentVersion.startsWith("v") ? currentVersion.slice(1) : currentVersion;
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

// src/services/monorepo-detector.ts
import { parse as parseYaml } from "yaml";
import picomatch from "picomatch";
var DETECTORS = [
  { file: "pnpm-workspace.yaml", type: "pnpm-workspaces" },
  { file: "turbo.json", type: "turborepo" },
  { file: "nx.json", type: "nx" },
  { file: "lerna.json", type: "lerna" }
];
function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function safeParseYaml(text) {
  if (!text) return null;
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
}
async function detectFlavor(reader, repo, ref) {
  for (const d of DETECTORS) {
    const content = await reader.getFileContent(repo, d.file, ref);
    if (content == null) continue;
    if (d.type === "pnpm-workspaces") {
      const parsed2 = safeParseYaml(content);
      return { type: "pnpm-workspaces", globs: parsed2?.packages ?? [] };
    }
    if (d.type === "turborepo") {
      const rootPkg2 = await reader.getFileContent(repo, "package.json", ref);
      const parsed2 = safeParseJson(rootPkg2);
      return { type: "turborepo", globs: normalizeWorkspaces(parsed2) };
    }
    if (d.type === "nx") {
      const parsed2 = safeParseJson(content);
      const projectPaths = parsed2?.projects ? Object.keys(parsed2.projects) : [];
      const globs2 = projectPaths.length > 0 ? projectPaths : ["apps/*", "libs/*"];
      return { type: "nx", globs: globs2 };
    }
    if (d.type === "lerna") {
      const parsed2 = safeParseJson(content);
      return { type: "lerna", globs: parsed2?.packages ?? ["packages/*"] };
    }
  }
  const rootPkg = await reader.getFileContent(repo, "package.json", ref);
  const parsed = safeParseJson(rootPkg);
  const globs = normalizeWorkspaces(parsed);
  if (globs.length === 0) return null;
  const isYarn = typeof parsed?.packageManager === "string" && parsed.packageManager.startsWith("yarn");
  return { type: isYarn ? "yarn-workspaces" : "npm-workspaces", globs };
}
function normalizeWorkspaces(pkg) {
  if (!pkg?.workspaces) return [];
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  return pkg.workspaces.packages ?? [];
}
async function expandGlobs(reader, repo, globs, ref) {
  const candidates = /* @__PURE__ */ new Set();
  for (const g of globs) {
    const trimmed = g.replace(/^\.\//, "").replace(/\/$/, "");
    const literal = !trimmed.includes("*");
    if (literal) {
      candidates.add(trimmed);
      continue;
    }
    const slashIdx = trimmed.indexOf("/");
    const parent = slashIdx === -1 ? "." : trimmed.slice(0, slashIdx);
    const matcher = picomatch(trimmed);
    const children = await reader.listDirectory(repo, parent, ref);
    for (const child of children) {
      const candidate = parent === "." ? child : `${parent}/${child}`;
      if (matcher(candidate)) candidates.add(candidate);
    }
  }
  return [...candidates];
}
async function readPackageInfo(reader, repo, path, ref) {
  const packageJsonPath = path === "." ? "package.json" : `${path}/package.json`;
  const raw = await reader.getFileContent(repo, packageJsonPath, ref);
  const parsed = safeParseJson(raw);
  if (!parsed || !parsed.name) return null;
  return {
    name: parsed.name,
    path,
    currentVersion: parsed.version ?? "0.0.0",
    packageJsonPath,
    changelogPath: path === "." ? "CHANGELOG.md" : `${path}/CHANGELOG.md`,
    affectedPRs: []
  };
}
async function detectMonorepo(reader, repo, ref) {
  const rootPackage = await readPackageInfo(reader, repo, ".", ref);
  const flavor = await detectFlavor(reader, repo, ref);
  if (!flavor) {
    return {
      type: "none",
      packages: [],
      rootPackage
    };
  }
  const paths = await expandGlobs(reader, repo, flavor.globs, ref);
  const packages = [];
  for (const p of paths) {
    const info = await readPackageInfo(reader, repo, p, ref);
    if (info) packages.push(info);
  }
  return { type: flavor.type, packages, rootPackage };
}
function attributePRsToPackages(info, prsWithFiles) {
  const updatedPackages = info.packages.map((pkg) => {
    const prefix = pkg.path === "." ? "" : `${pkg.path}/`;
    const affected = prsWithFiles.filter(
      ({ files }) => files.some((f) => prefix === "" ? true : f.startsWith(prefix))
    ).map(({ pr }) => pr);
    return { ...pkg, affectedPRs: affected };
  });
  return { ...info, packages: updatedPackages };
}

// src/services/config-reader.ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { DEFAULT_CONFIG } from "@tagline-sh/shared";
var CONFIG_FILE = ".release-agent.md";
var BRANCHES_HEADING = /^branches$/i;
var PRERELEASE_HEADING = /^pre[- ]?release tags?$/i;
var NOTES_HEADING = /^release notes? style$/i;
async function readRepoConfig(reader, repo, ref) {
  const content = await reader.getFileContent(repo, CONFIG_FILE, ref);
  if (content == null) return DEFAULT_CONFIG;
  const sections = parseSections(content);
  return {
    branches: {
      production: sections.branches["production"] ?? DEFAULT_CONFIG.branches.production,
      staging: sections.branches["staging"] ?? DEFAULT_CONFIG.branches.staging,
      development: sections.branches["development"] ?? DEFAULT_CONFIG.branches.development
    },
    preReleaseSuffix: {
      staging: sections.preRelease["staging suffix"] ?? sections.preRelease["staging"] ?? DEFAULT_CONFIG.preReleaseSuffix.staging,
      development: sections.preRelease["development suffix"] ?? sections.preRelease["development"] ?? DEFAULT_CONFIG.preReleaseSuffix.development
    },
    releaseNotesStyle: sections.notesStyle.trim(),
    customContext: sections.customContext.trim(),
    rawContent: content
  };
}
function parseSections(markdown) {
  const tree = unified().use(remarkParse).parse(markdown);
  const branches = {};
  const preRelease = {};
  const notesStyleParts = [];
  const customContextParts = [];
  let currentHeading = null;
  let currentBody = [];
  const flush = () => {
    if (!currentHeading) {
      if (currentBody.length) {
        customContextParts.push(stringifyNodes(markdown, currentBody));
      }
      return;
    }
    if (BRANCHES_HEADING.test(currentHeading)) {
      Object.assign(branches, extractKeyValueList(currentBody));
    } else if (PRERELEASE_HEADING.test(currentHeading)) {
      Object.assign(preRelease, extractKeyValueList(currentBody));
    } else if (NOTES_HEADING.test(currentHeading)) {
      notesStyleParts.push(stringifyNodes(markdown, currentBody));
    } else {
      customContextParts.push(`## ${currentHeading}

${stringifyNodes(markdown, currentBody)}`);
    }
  };
  for (const child of tree.children) {
    if (child.type === "heading" && child.depth === 2) {
      flush();
      currentHeading = headingText(child);
      currentBody = [];
    } else {
      currentBody.push(child);
    }
  }
  flush();
  return {
    branches,
    preRelease,
    notesStyle: notesStyleParts.join("\n\n"),
    customContext: customContextParts.join("\n\n")
  };
}
function headingText(heading) {
  let buf = "";
  visit(heading, "text", (node) => {
    buf += node.value;
  });
  return buf.trim();
}
function extractKeyValueList(nodes) {
  const out = {};
  for (const node of nodes) {
    if (node.type !== "list") continue;
    for (const item of node.children) {
      const line = listItemText(item);
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) out[key] = value;
    }
  }
  return out;
}
function listItemText(item) {
  let buf = "";
  visit(item, "text", (node) => {
    buf += node.value;
  });
  return buf.trim();
}
function stringifyNodes(source, nodes) {
  if (nodes.length === 0) return "";
  const first = nodes[0]?.position?.start.offset ?? 0;
  const last = nodes[nodes.length - 1]?.position?.end.offset ?? source.length;
  return source.slice(first, last).trim();
}

// src/services/changelog-writer.ts
var TYPE_TO_SECTION = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  revert: "Changed",
  docs: "Changed",
  style: "Changed",
  build: "Changed",
  ci: "Changed",
  chore: "Changed",
  test: "Changed",
  breaking: "Removed"
};
function isoDate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function bestSubject(pr) {
  const interesting = pr.commits.find((c) => c.type === "feat" || c.type === "fix");
  if (interesting) return interesting.subject;
  const first = pr.commits[0];
  return first?.subject ?? pr.title;
}
function ticketSuffix(pr) {
  if (pr.tickets.length === 0) return "";
  return " \xB7 " + pr.tickets.join(", ");
}
function bulletForPR(pr) {
  const subject = bestSubject(pr);
  return `- ${subject} ([#${pr.number}](${pr.url}))${ticketSuffix(pr)}`;
}
function sectionForPR(pr) {
  if (pr.commits.some((c) => c.isBreaking)) return "Removed";
  if (pr.commits.some((c) => c.type === "feat")) return "Added";
  if (pr.commits.some((c) => c.type === "fix")) return "Fixed";
  const first = pr.commits[0];
  return first ? TYPE_TO_SECTION[first.type] ?? "Changed" : "Changed";
}
function renderChangelogEntry(input) {
  const date = input.date ?? isoDate(/* @__PURE__ */ new Date());
  const version = input.version.startsWith("v") ? input.version.slice(1) : input.version;
  const buckets = {
    Added: [],
    Fixed: [],
    Changed: [],
    Removed: []
  };
  for (const pr of input.prs) {
    const section = sectionForPR(pr);
    buckets[section].push(bulletForPR(pr));
  }
  const lines = [`## [${version}] - ${date}`];
  for (const section of ["Added", "Fixed", "Changed", "Removed"]) {
    const items = buckets[section];
    if (items.length === 0) continue;
    lines.push("", `### ${section}`, "", ...items);
  }
  return lines.join("\n") + "\n";
}
var CHANGELOG_HEADER = [
  "# Changelog",
  "",
  "All notable changes to this project are documented in this file.",
  "",
  "The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),",
  "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).",
  ""
].join("\n");

// src/services/report-generator.ts
import OpenAI from "openai";
import { AI_DEFAULTS } from "@tagline-sh/shared";
var SYSTEM_PROMPT = "You are a release manager assistant for software engineering teams. You help generate clear, accurate release reports based on merged pull requests. Be concise and technical. Do not embellish or invent features. Only describe what is in the provided PR data.";
function buildUserPrompt(input) {
  const { prs, suggestedBump, config } = input;
  const prLines = prs.map((pr) => {
    const types = pr.commits.map((c) => c.type).join(", ") || "chore";
    const tickets = pr.tickets.join(", ") || "none";
    const body = pr.bodyExcerpt ? `
  Description: ${pr.bodyExcerpt}` : "";
    return `- PR #${pr.number}: ${pr.title} (by @${pr.author})
  Type: ${types}
  Tickets: ${tickets}${body}`;
  }).join("\n");
  const style = config.releaseNotesStyle || "Write clear, concise release notes for a developer audience.";
  const ctx = config.customContext ? `

${config.customContext}` : "";
  return [
    "Generate a release report summary based on these merged pull requests.",
    "",
    "## Merged PRs",
    prLines,
    "",
    `## Suggested version bump: ${suggestedBump}`,
    "",
    "## Repository context (from .release-agent.md):",
    style + ctx,
    "",
    "## Your task",
    "1. Write 2\u20133 sentences explaining WHY the suggested version bump is appropriate,",
    "   referencing specific PRs by number.",
    "2. Write a changelog preview in Keep a Changelog format (### Added, ### Fixed,",
    "   ### Changed, ### Removed sections \u2014 only include sections with content).",
    "   Each entry should be a single line. Reference PR numbers and ticket numbers where available.",
    "",
    "Respond with valid JSON matching this schema:",
    "{",
    '  "reasoning": "<2-3 sentence explanation>",',
    '  "changelogPreview": "<markdown formatted changelog>"',
    "}"
  ].join("\n");
}
var FALLBACK_REASONING = "AI unavailable \u2014 manual review required";
function deterministicReport(input) {
  return {
    reasoning: FALLBACK_REASONING,
    changelogPreview: renderChangelogEntry({
      version: input.suggestedVersion,
      prs: input.prs
    }),
    aiUsed: false
  };
}
var DEFAULT_TIMEOUT_MS = 2e4;
async function generateReport(input, options) {
  const model = options.model ?? AI_DEFAULTS.model;
  const baseURL = options.baseUrl ?? AI_DEFAULTS.baseUrl;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = options.client ?? new OpenAI({
    apiKey: options.apiKey,
    baseURL
  });
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2
      },
      { timeout: timeoutMs }
    );
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return deterministicReport(input);
    const parsed = JSON.parse(raw);
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : null;
    const changelogPreview = typeof parsed.changelogPreview === "string" ? parsed.changelogPreview : null;
    if (!reasoning || !changelogPreview) {
      return deterministicReport(input);
    }
    return {
      reasoning,
      changelogPreview,
      aiUsed: true
    };
  } catch {
    return deterministicReport(input);
  }
}

// src/services/pr-reader.ts
import semver2 from "semver";
var SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+([+-][\w.]+)?$/;
async function getLastReleaseTag(reader, repo) {
  const tags = await reader.listTags(repo);
  const semverTags = tags.filter((t) => SEMVER_TAG_RE.test(t.name));
  if (semverTags.length === 0) return null;
  semverTags.sort((a, b) => {
    const av = semver2.coerce(a.name)?.version ?? "0.0.0";
    const bv = semver2.coerce(b.name)?.version ?? "0.0.0";
    return semver2.rcompare(av, bv);
  });
  return semverTags[0] ?? null;
}
async function getCurrentVersion(reader, repo, ref) {
  const raw = await reader.getFileContent(repo, "package.json", ref);
  if (raw) {
    try {
      const pkg = JSON.parse(raw);
      if (pkg.version && semver2.valid(pkg.version)) return pkg.version;
    } catch {
    }
  }
  const tag = await getLastReleaseTag(reader, repo);
  if (tag) {
    const stripped = tag.name.replace(/^v/, "");
    if (semver2.valid(stripped)) return stripped;
  }
  return "0.0.0";
}
async function getPRsSinceLastTag(reader, repo, branch) {
  const lastTag = await getLastReleaseTag(reader, repo);
  const since = lastTag?.commitDate ?? null;
  const prs = await reader.listMergedPRs(repo, branch, since);
  return { prs, lastTag };
}
async function hydratePRs(reader, repo, summaries) {
  return Promise.all(
    summaries.map(async (summary) => {
      const [commits, files] = await Promise.all([
        reader.listPRCommits(repo, summary.number),
        reader.listPRFiles(repo, summary.number)
      ]);
      const { pr, nonConformant } = parsePR(summary, commits);
      return {
        pr,
        files: files.map((f) => f.filename),
        nonConformant
      };
    })
  );
}

// src/services/octokit-reader.ts
var OctokitGitHubReader = class {
  constructor(octokit) {
    this.octokit = octokit;
  }
  octokit;
  async getFileContent(repo, path, ref) {
    try {
      const res = await this.octokit.rest.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path,
        ...ref ? { ref } : {}
      });
      const data = res.data;
      if (Array.isArray(data) || data.type !== "file") return null;
      if (!("content" in data) || typeof data.content !== "string") return null;
      return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString(
        "utf8"
      );
    } catch (err) {
      if (isStatusError(err, 404)) return null;
      throw err;
    }
  }
  async listDirectory(repo, path, ref) {
    try {
      const res = await this.octokit.rest.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path: path === "." ? "" : path,
        ...ref ? { ref } : {}
      });
      const data = res.data;
      if (!Array.isArray(data)) return [];
      return data.map((entry) => entry.name);
    } catch (err) {
      if (isStatusError(err, 404)) return [];
      throw err;
    }
  }
  async listTags(repo) {
    const result = [];
    const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listTags, {
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100
    });
    for await (const { data } of iterator) {
      for (const tag of data) {
        const sha = tag.commit.sha;
        const commit = await this.octokit.rest.git.getCommit({
          owner: repo.owner,
          repo: repo.repo,
          commit_sha: sha
        });
        result.push({
          name: tag.name,
          sha,
          commitDate: commit.data.committer?.date ?? commit.data.author?.date ?? ""
        });
      }
    }
    return result;
  }
  async getDefaultBranch(repo) {
    const res = await this.octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.repo
    });
    return res.data.default_branch;
  }
  async listMergedPRs(repo, branch, since) {
    const qParts = [
      `repo:${repo.owner}/${repo.repo}`,
      "is:pr",
      "is:merged",
      `base:${branch}`
    ];
    if (since) qParts.push(`merged:>${since}`);
    const q = qParts.join(" ");
    const summaries = [];
    const iterator = this.octokit.paginate.iterator(
      this.octokit.rest.search.issuesAndPullRequests,
      { q, sort: "created", order: "asc", per_page: 100 }
    );
    for await (const { data } of iterator) {
      for (const item of data) {
        const full = await this.octokit.rest.pulls.get({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: item.number
        });
        const p = full.data;
        if (!p.merged_at) continue;
        summaries.push({
          number: p.number,
          title: p.title,
          body: p.body ?? null,
          url: p.html_url,
          author: p.user?.login ?? "unknown",
          mergedAt: p.merged_at,
          baseRef: p.base.ref,
          headRef: p.head.ref
        });
      }
    }
    return summaries;
  }
  async listPRCommits(repo, prNumber) {
    const result = [];
    const iterator = this.octokit.paginate.iterator(
      this.octokit.rest.pulls.listCommits,
      {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        per_page: 100
      }
    );
    for await (const { data } of iterator) {
      for (const c of data) {
        result.push({
          sha: c.sha,
          message: c.commit.message,
          author: c.author?.login ?? null
        });
      }
    }
    return result;
  }
  async listPRFiles(repo, prNumber) {
    const result = [];
    const iterator = this.octokit.paginate.iterator(this.octokit.rest.pulls.listFiles, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      per_page: 100
    });
    for await (const { data } of iterator) {
      for (const f of data) result.push({ filename: f.filename });
    }
    return result;
  }
};
function isStatusError(err, status) {
  return typeof err === "object" && err !== null && "status" in err && err.status === status;
}

// src/commands/release-report.ts
async function buildReleaseReport(input) {
  const reader = new OctokitGitHubReader(input.octokit);
  const repoRef = { owner: input.owner, repo: input.repo };
  const config = await readRepoConfig(reader, repoRef);
  const branch = input.branch ?? config.branches.production;
  const [monorepo, currentVersion, { prs: summaries, lastTag }] = await Promise.all([
    detectMonorepo(reader, repoRef, branch),
    getCurrentVersion(reader, repoRef, branch),
    getPRsSinceLastTag(reader, repoRef, branch)
  ]);
  const hydrated = await hydratePRs(reader, repoRef, summaries);
  const parsedPRs = hydrated.map((h) => h.pr);
  const suggestedBump = aggregatePRBumps(parsedPRs);
  const suggestedVersion = suggestedBump === "none" ? currentVersion : calculateNextVersion(currentVersion, suggestedBump, branch, config);
  const monorepoInfo = monorepo.type === "none" ? null : attributePRsToPackages(
    monorepo,
    hydrated.map((h) => ({ pr: h.pr, files: h.files }))
  );
  let aiOutput;
  if (input.ai?.apiKey) {
    aiOutput = await generateReport(
      { prs: parsedPRs, suggestedBump, suggestedVersion, config },
      input.ai
    );
  } else {
    aiOutput = deterministicReport({
      prs: parsedPRs,
      suggestedBump,
      suggestedVersion,
      config
    });
  }
  const report = {
    repoOwner: input.owner,
    repoName: input.repo,
    baseBranch: branch,
    lastTag: lastTag?.name ?? null,
    lastTagDate: lastTag?.commitDate ?? null,
    prs: parsedPRs,
    suggestedBump,
    suggestedVersion,
    currentVersion,
    reasoning: aiOutput.reasoning,
    changelogPreview: aiOutput.changelogPreview,
    isMonorepo: monorepoInfo !== null,
    monorepoInfo,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  return { report, aiUsed: aiOutput.aiUsed };
}

// src/commands/approve.ts
import { RELEASE_WORKFLOW_FILE } from "@tagline-sh/shared";
var VALID_BUMPS = /* @__PURE__ */ new Set(["major", "minor", "patch"]);
function parseApproveCommand(args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let bumpOverride = null;
  let isDraft = false;
  let isDryRun = false;
  let branchOverride = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--draft") {
      isDraft = true;
      continue;
    }
    if (t === "--dry-run") {
      isDryRun = true;
      continue;
    }
    if (t === "--branch") {
      const next = tokens[i + 1];
      if (!next) return null;
      branchOverride = next;
      i += 1;
      continue;
    }
    if (VALID_BUMPS.has(t)) {
      if (bumpOverride) return null;
      bumpOverride = t;
      continue;
    }
    return null;
  }
  return { bumpOverride, isDraft, isDryRun, branchOverride };
}
async function buildApprovePlan(input) {
  const reportInput = {
    octokit: input.octokit,
    owner: input.owner,
    repo: input.repo
  };
  if (input.command.branchOverride) reportInput.branch = input.command.branchOverride;
  if (input.ai) reportInput.ai = input.ai;
  const { report } = await buildReleaseReport(reportInput);
  if (report.prs.length === 0) {
    return {
      plan: emptyPlan(input, report.baseBranch, report.currentVersion),
      empty: true
    };
  }
  const finalBump = input.command.bumpOverride ?? report.suggestedBump;
  const finalVersion = finalBump === "none" ? report.currentVersion : calculateNextVersion(
    report.currentVersion,
    finalBump,
    report.baseBranch,
    await readConfigForCalc(input, report.baseBranch)
  );
  const det = deterministicReport({
    prs: report.prs,
    suggestedBump: finalBump,
    suggestedVersion: finalVersion,
    config: await readConfigForCalc(input, report.baseBranch)
  });
  const plan = {
    repoOwner: input.owner,
    repoName: input.repo,
    baseBranch: report.baseBranch,
    bumpType: finalBump,
    currentVersion: report.currentVersion,
    nextVersion: finalVersion,
    lastTag: report.lastTag,
    prs: report.prs,
    changelogContent: det.changelogPreview,
    isMonorepo: report.isMonorepo,
    monorepoInfo: report.monorepoInfo,
    isDraft: input.command.isDraft,
    isDryRun: input.command.isDryRun,
    issueNumber: input.issueNumber,
    approvedBy: input.approvedBy,
    approvedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  return { plan, empty: false };
}
function emptyPlan(input, baseBranch, currentVersion) {
  return {
    repoOwner: input.owner,
    repoName: input.repo,
    baseBranch,
    bumpType: "none",
    currentVersion,
    nextVersion: currentVersion,
    lastTag: null,
    prs: [],
    changelogContent: "",
    isMonorepo: false,
    monorepoInfo: null,
    isDraft: input.command.isDraft,
    isDryRun: input.command.isDryRun,
    issueNumber: input.issueNumber,
    approvedBy: input.approvedBy,
    approvedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function readConfigForCalc(input, _branch) {
  const reader = new OctokitGitHubReader(input.octokit);
  return readRepoConfig(reader, { owner: input.owner, repo: input.repo });
}
async function dispatchReleaseWorkflow(octokit, owner, repo, plan) {
  try {
    await octokit.rest.repos.getContent({
      owner,
      repo,
      path: `.github/workflows/${RELEASE_WORKFLOW_FILE}`
    });
  } catch (err) {
    if (isStatus(err, 404)) return { dispatched: false, missingWorkflow: true };
    return {
      dispatched: false,
      missingWorkflow: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: RELEASE_WORKFLOW_FILE,
      ref: plan.baseBranch,
      inputs: {
        release_plan: JSON.stringify(plan),
        issue_number: String(plan.issueNumber),
        dry_run: plan.isDryRun ? "true" : "false"
      }
    });
    return { dispatched: true, missingWorkflow: false };
  } catch (err) {
    return {
      dispatched: false,
      missingWorkflow: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
function isStatus(err, status) {
  return typeof err === "object" && err !== null && "status" in err && err.status === status;
}

// src/utils/comments.ts
import {
  APP_DISPLAY_NAME
} from "@tagline-sh/shared";
function acknowledgementComment(action) {
  if (action === "report") {
    return `${APP_DISPLAY_NAME} is generating your release report \u2014 one moment\u2026`;
  }
  return `${APP_DISPLAY_NAME} is preparing your release \u2014 one moment\u2026`;
}
var SECTION_HEADERS = {
  feat: "### \u2728 New features",
  fix: "### \u{1F41B} Bug fixes",
  chore: "### \u{1F527} Chores & maintenance"
};
function ticketSuffix2(pr) {
  if (pr.tickets.length === 0) return "";
  return " \xB7 " + pr.tickets.map((t) => `\`${t}\``).join(" ");
}
function prLine(pr) {
  return `- ${pr.title} \xB7 [#${pr.number}](${pr.url})${ticketSuffix2(pr)}`;
}
function groupPRs(prs) {
  const groups = {
    feat: [],
    fix: [],
    chore: []
  };
  for (const pr of prs) {
    if (pr.commits.some((c) => c.type === "feat" || c.isBreaking)) {
      groups.feat.push(pr);
    } else if (pr.commits.some((c) => c.type === "fix" || c.type === "perf")) {
      groups.fix.push(pr);
    } else {
      groups.chore.push(pr);
    }
  }
  return groups;
}
function uniqueAuthors(prs) {
  return new Set(prs.map((pr) => pr.author)).size;
}
function totalCommits(prs) {
  return prs.reduce((acc, pr) => acc + pr.commits.length, 0);
}
var BUMP_LABELS = {
  major: "major",
  minor: "minor",
  patch: "patch",
  none: "none"
};
function formatSince(report) {
  if (!report.lastTag) return "_first release_";
  const date = report.lastTagDate ? new Date(report.lastTagDate) : null;
  if (!date || Number.isNaN(date.getTime())) return `\`${report.lastTag}\``;
  const formatted = date.toUTCString().slice(5, 16);
  return `\`${report.lastTag}\` \xB7 ${formatted}`;
}
function reportComment(report) {
  const groups = groupPRs(report.prs);
  const bumpHint = BUMP_LABELS[report.suggestedBump];
  const lines = [];
  lines.push(`## Release report \u2014 generated by ${APP_DISPLAY_NAME}`);
  lines.push("");
  lines.push(
    `**Since:** ${formatSince(report)} &nbsp;|&nbsp; **Branch:** \`${report.baseBranch}\``
  );
  lines.push(
    `**PRs analyzed:** ${report.prs.length} &nbsp;|&nbsp; **Commits:** ${totalCommits(
      report.prs
    )} &nbsp;|&nbsp; **Contributors:** ${uniqueAuthors(report.prs)}`
  );
  lines.push("");
  lines.push("---");
  if (groups.feat.length > 0) {
    lines.push("");
    lines.push(`${SECTION_HEADERS.feat} \xB7 suggests \`${bumpHint}\` bump`);
    lines.push("");
    for (const pr of groups.feat) lines.push(prLine(pr));
  }
  if (groups.fix.length > 0) {
    lines.push("");
    lines.push(SECTION_HEADERS.fix);
    lines.push("");
    for (const pr of groups.fix) lines.push(prLine(pr));
  }
  if (groups.chore.length > 0) {
    lines.push("");
    lines.push(SECTION_HEADERS.chore);
    lines.push("");
    for (const pr of groups.chore) lines.push(prLine(pr));
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### Recommendation");
  lines.push("");
  lines.push(`**Suggested bump:** \`${bumpHint}\` \u2192 \`v${report.suggestedVersion}\``);
  lines.push("");
  for (const line of report.reasoning.split("\n")) lines.push(`> ${line}`);
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Changelog preview</summary>");
  lines.push("");
  lines.push("```markdown");
  lines.push(report.changelogPreview.trimEnd());
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Reply with a command to release:");
  lines.push(
    "`/approve` &nbsp; `/approve patch` &nbsp; `/approve minor` &nbsp; `/approve major` &nbsp; `/approve --draft` &nbsp; `/approve --dry-run`"
  );
  return lines.join("\n");
}
function noChangesComment(lastTag) {
  if (!lastTag) {
    return `${APP_DISPLAY_NAME}: no merged PRs detected. Nothing to release yet.`;
  }
  return `${APP_DISPLAY_NAME}: no changes detected since \`${lastTag}\`.`;
}
function missingWorkflowComment() {
  return [
    `${APP_DISPLAY_NAME} can't trigger the release because \`.github/workflows/release-agent.yml\` is missing.`,
    "",
    "Add this file to your repo:",
    "",
    "```yaml",
    "name: Release Agent",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      release_plan:",
    "        required: true",
    "        type: string",
    "      issue_number:",
    "        required: false",
    "        type: string",
    '        default: ""',
    "      dry_run:",
    "        required: false",
    "        type: boolean",
    "        default: false",
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with: { fetch-depth: 0 }",
    "      - uses: tagline-sh/release-agent-action@v1",
    "        with:",
    "          release_plan: ${{ inputs.release_plan }}",
    "          github_token: ${{ secrets.GITHUB_TOKEN }}",
    "          issue_number: ${{ inputs.issue_number }}",
    "          dry_run: ${{ inputs.dry_run }}",
    "```"
  ].join("\n");
}
function noPermissionComment(username) {
  return `@${username}, you need write access to this repository to use ${APP_DISPLAY_NAME} commands.`;
}
function errorComment(action) {
  return `${APP_DISPLAY_NAME} hit an error while ${action}. Please try again, or check the bot logs.`;
}
function welcomeIssue() {
  return {
    title: `\u{1F44B} Welcome to ${APP_DISPLAY_NAME}`,
    body: [
      `Thanks for installing **${APP_DISPLAY_NAME}**!`,
      "",
      "Here's what to do next:",
      "",
      "- [ ] Add `.github/workflows/release-agent.yml` to your repo (see the docs).",
      "- [ ] Set `AI_API_KEY` in your repo secrets (any OpenAI-compatible provider).",
      `- [ ] Optionally add \`.release-agent.md\` to configure ${APP_DISPLAY_NAME}.`,
      "- [ ] Comment `/release-report` on any issue to generate your first report.",
      "",
      `Questions? See the [docs](https://github.com/tagline-sh/tagline-sh).`
    ].join("\n")
  };
}

// src/utils/permissions.ts
async function checkWritePermission(octokit, repo, username) {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: repo.owner,
      repo: repo.repo,
      username
    });
    return ["write", "maintain", "admin"].includes(data.permission);
  } catch {
    return false;
  }
}

// src/handlers/issue-comment.ts
var asReader = (octokit) => octokit;
var asPermissions = (octokit) => octokit;
var asDispatch = (octokit) => octokit;
var COMMAND_RE = /^\/(\S+)(?:\s+(.*))?$/;
function readAIConfig() {
  const apiKey = process.env["AI_API_KEY"];
  if (!apiKey) return void 0;
  return {
    apiKey,
    baseUrl: process.env["AI_BASE_URL"],
    model: process.env["AI_MODEL"]
  };
}
async function handleIssueComment(context) {
  const comment = context.payload.comment;
  const sender = context.payload.sender;
  if (sender.type === "Bot") return;
  const body = comment.body.trim();
  const matched = COMMAND_RE.exec(body);
  if (!matched) return;
  const command = matched[1].toLowerCase();
  const args = (matched[2] ?? "").trim();
  const repo = context.repo();
  const issueNumber = context.payload.issue.number;
  const allowed = await checkWritePermission(asPermissions(context.octokit), repo, sender.login);
  if (!allowed) {
    await context.octokit.rest.issues.createComment({
      ...repo,
      issue_number: issueNumber,
      body: noPermissionComment(sender.login)
    });
    return;
  }
  switch (command) {
    case "release-report":
      await runReleaseReport(context, args);
      return;
    case "approve":
      await runApprove(context, sender.login, args);
      return;
    default:
      return;
  }
}
async function runReleaseReport(context, args) {
  const repo = context.repo();
  const issueNumber = context.payload.issue.number;
  const branchMatch = /--branch\s+(\S+)/.exec(args);
  const branchOverride = branchMatch?.[1];
  const ack = await context.octokit.rest.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: acknowledgementComment("report")
  });
  try {
    const buildOpts = {
      octokit: asReader(context.octokit),
      owner: repo.owner,
      repo: repo.repo
    };
    if (branchOverride) buildOpts.branch = branchOverride;
    const ai = readAIConfig();
    if (ai) buildOpts.ai = ai;
    const { report } = await buildReleaseReport(buildOpts);
    const body = report.prs.length === 0 ? noChangesComment(report.lastTag) : reportComment(report);
    await context.octokit.rest.issues.updateComment({
      ...repo,
      comment_id: ack.data.id,
      body
    });
  } catch (err) {
    context.log.error({ err }, "release-report failed");
    await context.octokit.rest.issues.updateComment({
      ...repo,
      comment_id: ack.data.id,
      body: errorComment("generating the release report")
    });
  }
}
async function runApprove(context, approvedBy, args) {
  const repo = context.repo();
  const issueNumber = context.payload.issue.number;
  const command = parseApproveCommand(args);
  if (!command) {
    await context.octokit.rest.issues.createComment({
      ...repo,
      issue_number: issueNumber,
      body: `${APP_DISPLAY_NAME2}: I didn't understand that \`/approve\` command. Valid forms: \`/approve\`, \`/approve patch|minor|major\`, plus \`--draft\` / \`--dry-run\`.`
    });
    return;
  }
  const ack = await context.octokit.rest.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: acknowledgementComment("approve")
  });
  try {
    const buildInput = {
      octokit: asReader(context.octokit),
      owner: repo.owner,
      repo: repo.repo,
      command,
      approvedBy,
      issueNumber
    };
    const ai = readAIConfig();
    if (ai) buildInput.ai = ai;
    const { plan, empty } = await buildApprovePlan(buildInput);
    if (empty) {
      await context.octokit.rest.issues.updateComment({
        ...repo,
        comment_id: ack.data.id,
        body: noChangesComment(plan.lastTag)
      });
      return;
    }
    const dispatch = await dispatchReleaseWorkflow(
      asDispatch(context.octokit),
      repo.owner,
      repo.repo,
      plan
    );
    if (dispatch.missingWorkflow) {
      await context.octokit.rest.issues.updateComment({
        ...repo,
        comment_id: ack.data.id,
        body: missingWorkflowComment()
      });
      return;
    }
    if (!dispatch.dispatched) {
      context.log.error({ dispatch }, "workflow_dispatch failed");
      await context.octokit.rest.issues.updateComment({
        ...repo,
        comment_id: ack.data.id,
        body: errorComment("dispatching the release workflow")
      });
      return;
    }
    await context.octokit.rest.issues.updateComment({
      ...repo,
      comment_id: ack.data.id,
      body: buildDispatchAckBody(plan, repo)
    });
  } catch (err) {
    context.log.error({ err }, "approve failed");
    await context.octokit.rest.issues.updateComment({
      ...repo,
      comment_id: ack.data.id,
      body: errorComment("preparing the release")
    });
  }
}
function buildDispatchAckBody(plan, repo) {
  const tag = `v${plan.nextVersion}`;
  const workflowsUrl = `https://github.com/${repo.owner}/${repo.repo}/actions/workflows/release-agent.yml`;
  const flags = [];
  if (plan.isDraft) flags.push("draft");
  if (plan.isDryRun) flags.push("dry-run");
  const flagsLine = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return [
    `${APP_DISPLAY_NAME2} is releasing \`${tag}\`${flagsLine} \u2014 workflow dispatched by @${plan.approvedBy}.`,
    "",
    `Track progress: ${workflowsUrl}`
  ].join("\n");
}
function register(app2) {
  app2.on("issue_comment.created", handleIssueComment);
}

// src/handlers/pull-request.ts
var asReader2 = (octokit) => octokit;
async function handlePullRequestClosed(context) {
  const pr = context.payload.pull_request;
  if (!pr.merged) return;
  const reader = new OctokitGitHubReader(asReader2(context.octokit));
  const config = await readRepoConfig(reader, context.repo());
  const tracked = [
    config.branches.production,
    config.branches.staging,
    config.branches.development
  ].filter((b) => Boolean(b));
  if (!tracked.includes(pr.base.ref)) return;
  context.log.info(
    {
      repo: context.repo(),
      pr: pr.number,
      branch: pr.base.ref
    },
    "PR merged into tracked branch"
  );
}
function register2(app2) {
  app2.on("pull_request.closed", handlePullRequestClosed);
}

// src/handlers/installation.ts
async function handleInstallationCreated(context) {
  const repos = context.payload.repositories ?? [];
  const owner = context.payload.installation.account.login;
  const { title, body } = welcomeIssue();
  for (const r of repos) {
    try {
      await context.octokit.rest.issues.create({
        owner,
        repo: r.name,
        title,
        body
      });
    } catch (err) {
      context.log.error({ err, repo: r.name }, "failed to open welcome issue");
    }
  }
}
function register3(app2) {
  app2.on("installation.created", handleInstallationCreated);
}

// src/index.ts
import { APP_DISPLAY_NAME as APP_DISPLAY_NAME3 } from "@tagline-sh/shared";
var app = (app2) => {
  app2.log.info(`${APP_DISPLAY_NAME3} bot ready \u2014 listening for webhooks.`);
  register(app2);
  register2(app2);
  register3(app2);
};
var index_default = app;
export {
  index_default as default
};
//# sourceMappingURL=index.js.map