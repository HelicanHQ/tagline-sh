import type { BumpType, RepoConfig, VersioningConfig } from './types';

// --- Branding -----------------------------------------------------------------

/** Human-facing product name. Used in bot comments, doc headers, GitHub App name. */
export const APP_DISPLAY_NAME = 'Tagline';

/** npm package / repo identifier. */
export const APP_PACKAGE_NAME = 'tagline-sh';

/** Git identity used by the Action when committing release changes. */
export const BOT_GIT_IDENTITY = {
    name: `${APP_PACKAGE_NAME}[bot]`,
    email: `${APP_PACKAGE_NAME}[bot]@users.noreply.github.com`,
} as const;

// --- Conventional commits → semver bump --------------------------------------

/**
 * Commit-type → bump mapping per PLAN.md §11.
 *
 * BREAKING CHANGE in the footer or `!` after the type always wins and forces
 * `major` — that override is applied by the parser, not by this map.
 */
export const COMMIT_TYPE_BUMP: Record<string, BumpType> = {
    feat: 'minor',
    fix: 'patch',
    perf: 'patch',
    revert: 'patch',
    docs: 'none',
    style: 'none',
    refactor: 'none',
    test: 'none',
    build: 'none',
    ci: 'none',
    chore: 'none',
};

/**
 * Numeric ordering used to compute the max bump across a set of PRs.
 * Higher value = bigger release.
 */
export const BUMP_PRIORITY: Record<BumpType, number> = {
    none: 0,
    patch: 1,
    minor: 2,
    major: 3,
};

// --- Defaults ----------------------------------------------------------------

/**
 * Default calver pattern when the user opts into calver without specifying a
 * pattern. `YYYY.MM.MICRO` is the only npm-safe shape: months are rendered
 * UNPADDED (`2026.6.0`, not `2026.06.0`).
 *
 * Why not the zero-padded `YYYY.0M.MICRO`: SemVer — and therefore npm — forbids
 * leading zeros in the numeric MAJOR/MINOR/PATCH identifiers, so `2026.06.0`
 * is an *invalid* version that `npm publish` rejects. The `0M`/`0D` tokens are
 * still recognised by the parser for non-npm tagging workflows, but they make
 * `calculateNextVersion` throw the moment they would emit a leading zero.
 *
 * Intentionally a pure literal — `@tagline-sh/shared` is consumed by both bot
 * and action, and the action runs inside the user's CI runner where the bot's
 * env vars don't exist. Per-deployment overrides happen at the bot side via
 * `.release-agent.md` config, not via env vars in this shared package.
 */
export const DEFAULT_CALVER_PATTERN = 'YYYY.MM.MICRO';

export const DEFAULT_VERSIONING: VersioningConfig = {
    scheme: 'semver',
    pattern: null,
};

export const DEFAULT_CONFIG: RepoConfig = {
    branches: {
        production: 'main',
        staging: 'staging',
        development: 'develop',
    },
    preReleaseSuffix: {
        staging: 'rc',
        development: 'alpha',
    },
    versioning: DEFAULT_VERSIONING,
    releaseNotesStyle: '',
    customContext: '',
    rawContent: '',
};

/**
 * AI configuration defaults. The bot reads `process.env.AI_BASE_URL` /
 * `AI_MODEL` at startup and passes them as `options` to `generateReport`,
 * which falls back to these literals when an option is absent
 * (`options.baseUrl ?? AI_DEFAULTS.baseUrl`). Keeping the defaults as pure
 * literals here means the shared package has no env-var dependency and
 * works identically on the bot side (Node server) and the action side
 * (GitHub runner) — the two environments don't share env vars.
 */
export const AI_DEFAULTS = {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-3.1-flash-lite-preview',
} as const;

/** Workflow file the bot dispatches against in the user's repo. */
export const RELEASE_WORKFLOW_FILE = 'release-agent.yml';
