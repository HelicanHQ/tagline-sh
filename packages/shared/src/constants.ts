import type { BumpType, RepoConfig } from './types.js';

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
    releaseNotesStyle: '',
    customContext: '',
    rawContent: '',
};

/** AI configuration defaults. Users override via env vars at the bot host. */
export const AI_DEFAULTS = {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
} as const;

/** Workflow file the bot dispatches against in the user's repo. */
export const RELEASE_WORKFLOW_FILE = 'release-agent.yml';
