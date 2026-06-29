import semver from 'semver';
import {
    DEFAULT_CALVER_PATTERN,
    type BumpType,
    type ReleaseChannel,
    type RepoConfig,
    type VersioningScheme,
} from '@tagline-sh/shared';

/**
 * Compute the next version given a current version, a bump type, the active
 * branch, and the repo's config.
 *
 * The scheme is selected from `config.versioning.scheme`:
 *
 *   - `semver` (default) — classic semver math driven by `bumpType`.
 *     Production branch → clean bump. Staging/development → `-{suffix}.0`.
 *   - `calver` — pattern-driven; `bumpType` is ignored. The next version is
 *     computed from `now` (UTC) and the current version's parsed MICRO counter.
 *     MICRO increments when all other tokens match the current calendar; it
 *     resets to 0 otherwise.
 *   - `incremental` — `bumpType` is ignored; the trailing integer increments.
 *
 * For `bumpType === 'none'` under semver, the current version is returned
 * unchanged (preserves prior behavior). Non-semver schemes always produce a new
 * version when called — callers should not invoke this with `bumpType === 'none'`
 * for those schemes; the report code guards on PR count instead.
 *
 * `now` is injectable for deterministic tests. Defaults to `new Date()`.
 */
export function calculateNextVersion(
    currentVersion: string,
    bumpType: BumpType,
    branch: string,
    config: RepoConfig,
    now: Date = new Date(),
): string {
    const scheme: VersioningScheme = config.versioning.scheme;

    if (scheme === 'semver') {
        if (bumpType === 'none') return currentVersion;
        return appendPreReleaseSuffix(nextSemver(currentVersion, bumpType), branch, config);
    }

    if (scheme === 'calver') {
        const pattern = config.versioning.pattern ?? DEFAULT_CALVER_PATTERN;
        return appendPreReleaseSuffix(nextCalver(currentVersion, pattern, now), branch, config);
    }

    if (scheme === 'incremental') {
        return appendPreReleaseSuffix(nextIncremental(currentVersion), branch, config);
    }

    const exhaustive: never = scheme;
    throw new Error(`Unknown versioning scheme: ${String(exhaustive)}`);
}

/**
 * Version assumed for a first release (no prior tag, no `package.json#version`).
 * Only relevant for the semver scheme; calver / incremental compute their own
 * first version mechanically.
 */
export const FIRST_RELEASE_VERSION = '0.1.0';

// --- SemVer ------------------------------------------------------------------

function nextSemver(currentVersion: string, bumpType: Exclude<BumpType, 'none'>): string {
    const cleaned = currentVersion.startsWith('v') ? currentVersion.slice(1) : currentVersion;
    if (!semver.valid(cleaned)) {
        throw new Error(`calculateNextVersion: '${currentVersion}' is not valid semver`);
    }
    const base = semver.inc(cleaned, bumpType);
    if (!base) {
        throw new Error(`semver.inc returned null for ${cleaned} (${bumpType})`);
    }
    return base;
}

// --- Incremental -------------------------------------------------------------

function nextIncremental(currentVersion: string): string {
    const stripped = currentVersion.startsWith('v') ? currentVersion.slice(1) : currentVersion;
    const match = /^(\d+)/.exec(stripped);
    if (!match) return '1';
    return String(Number(match[1]) + 1);
}

// --- CalVer ------------------------------------------------------------------

type CalverToken = 'YYYY' | 'YY' | '0Y' | 'MM' | '0M' | 'DD' | '0D' | 'MICRO';

type NonMicroToken = Exclude<CalverToken, 'MICRO'>;

// Order matters: tokens whose name shares a prefix with another must come
// first. `YYYY` before `YY`; `MICRO` is unambiguous because no other token
// starts with `M`. `0X` tokens don't overlap with single-letter pairs.
const CALVER_TOKENS: ReadonlyArray<{ name: CalverToken; regex: string }> = [
    { name: 'MICRO', regex: '\\d+' },
    { name: 'YYYY', regex: '\\d{4}' },
    { name: '0Y', regex: '\\d{2}' },
    { name: '0M', regex: '\\d{2}' },
    { name: '0D', regex: '\\d{2}' },
    { name: 'YY', regex: '\\d{1,2}' },
    { name: 'MM', regex: '\\d{1,2}' },
    { name: 'DD', regex: '\\d{1,2}' },
];

interface CompiledPattern {
    regex: RegExp;
    tokenOrder: CalverToken[];
    parts: Array<{ type: 'token'; name: CalverToken } | { type: 'literal'; value: string }>;
}

function compileCalverPattern(pattern: string): CompiledPattern {
    const tokenOrder: CalverToken[] = [];
    const parts: CompiledPattern['parts'] = [];
    let regexBody = '';
    let i = 0;
    while (i < pattern.length) {
        const matched = CALVER_TOKENS.find((t) => pattern.startsWith(t.name, i));
        if (matched) {
            regexBody += '(' + matched.regex + ')';
            tokenOrder.push(matched.name);
            parts.push({ type: 'token', name: matched.name });
            i += matched.name.length;
        } else {
            const ch = pattern[i] ?? '';
            regexBody += escapeRegex(ch);
            parts.push({ type: 'literal', value: ch });
            i += 1;
        }
    }
    return { regex: new RegExp('^' + regexBody + '$'), tokenOrder, parts };
}

function escapeRegex(ch: string): string {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveToken(name: CalverToken, date: Date, micro: number): string {
    switch (name) {
        case 'YYYY':
            return String(date.getUTCFullYear());
        case '0Y':
            return String(date.getUTCFullYear() % 100).padStart(2, '0');
        case 'YY':
            return String(date.getUTCFullYear() % 100);
        case '0M':
            return String(date.getUTCMonth() + 1).padStart(2, '0');
        case 'MM':
            return String(date.getUTCMonth() + 1);
        case '0D':
            return String(date.getUTCDate()).padStart(2, '0');
        case 'DD':
            return String(date.getUTCDate());
        case 'MICRO':
            return String(micro);
    }
}

function renderCalver(compiled: CompiledPattern, date: Date, micro: number): string {
    return compiled.parts
        .map((p) => (p.type === 'literal' ? p.value : resolveToken(p.name, date, micro)))
        .join('');
}

interface ParsedCalver {
    micro: number | null;
    fixed: Partial<Record<NonMicroToken, string>>;
}

function parseCalver(version: string, compiled: CompiledPattern): ParsedCalver | null {
    const stripped = version.startsWith('v') ? version.slice(1) : version;
    // Drop any pre-release suffix so `2026.05.1-rc.0` parses against the same pattern.
    const base = stripped.replace(/-[A-Za-z0-9.-]+$/, '');
    const match = compiled.regex.exec(base);
    if (!match) return null;
    const fixed: ParsedCalver['fixed'] = {};
    let micro: number | null = null;
    compiled.tokenOrder.forEach((name, idx) => {
        const value = match[idx + 1] ?? '';
        if (name === 'MICRO') {
            micro = Number(value);
        } else {
            fixed[name] = value;
        }
    });
    return { micro, fixed };
}

function nextCalver(currentVersion: string, pattern: string, now: Date): string {
    if (!pattern.includes('MICRO')) {
        throw new Error(
            `CalVer pattern '${pattern}' must include the MICRO token so successive ` +
                'releases on the same day can be distinguished. Add `.MICRO` to the pattern.',
        );
    }
    const compiled = compileCalverPattern(pattern);

    const parsed = parseCalver(currentVersion, compiled);
    const rendered = parsed
        ? renderCalver(compiled, now, computeNextMicro(compiled, parsed, now))
        : renderCalver(compiled, now, 0);

    return assertNpmSafe(rendered, pattern);
}

/**
 * MICRO increments when every non-MICRO token still matches the current
 * calendar; any mismatch (a new month, year, …) resets it to 0.
 */
function computeNextMicro(compiled: CompiledPattern, parsed: ParsedCalver, now: Date): number {
    const allMatch = compiled.tokenOrder.every((name) => {
        if (name === 'MICRO') return true;
        return resolveToken(name, now, 0) === parsed.fixed[name as NonMicroToken];
    });
    return allMatch ? (parsed.micro ?? 0) + 1 : 0;
}

/**
 * Hard guardrail: a calver version that lands in a `package.json#version` or a
 * git tag MUST be valid SemVer, because npm rejects leading zeros (`2026.06.0`
 * is not a publishable version). This throws the moment a pattern produces one
 * — typically a `0M`/`0D` token on a single-digit month/day — instead of
 * silently shipping a version that breaks at `npm publish`.
 *
 * Note the failure is calendar-dependent by design: `0M` yields valid output in
 * October (`2026.10.0`) but throws in June (`2026.06.0`). That's exactly the
 * boundary we want — it throws iff it would emit a zero-padded number. The
 * remedy is always the same: switch the offending `0X` token to its unpadded
 * form (`MM`/`DD`/`YY`).
 */
function assertNpmSafe(version: string, pattern: string): string {
    if (semver.valid(version)) return version;
    throw new Error(
        `CalVer pattern '${pattern}' produced '${version}', which is not a valid npm/SemVer ` +
            `version (npm forbids leading zeros, e.g. '06'). Use unpadded tokens — 'MM' instead ` +
            `of '0M', 'DD' instead of '0D' — in your .release-agent.md 'pattern'.`,
    );
}

// --- Pre-release suffix (shared across schemes) ------------------------------

function appendPreReleaseSuffix(base: string, branch: string, config: RepoConfig): string {
    if (branch === config.branches.staging) {
        return `${base}-${config.preReleaseSuffix.staging}.0`;
    }
    if (branch === config.branches.development) {
        return `${base}-${config.preReleaseSuffix.development}.0`;
    }
    return base;
}

// --- Release channels --------------------------------------------------------

/** The release channel a branch maps to, or `null` if the branch isn't a channel. */
export function channelForBranch(config: RepoConfig, branch: string): ReleaseChannel | null {
    return config.channels.find((c) => c.branch === branch) ?? null;
}

/** The repo's stable (production) channel, or `null` if none is configured. */
export function stableChannel(config: RepoConfig): ReleaseChannel | null {
    return config.channels.find((c) => c.tier === 'stable') ?? null;
}

export interface ChannelVersionInput {
    /** The channel being released (its branch + tier + suffix). */
    channel: ReleaseChannel;
    /**
     * The latest STABLE version of this release line (no pre-release segment),
     * or `null` for a first release. The base is always anchored here so that
     * `alpha` and `rc` for the same upcoming release agree on the base version
     * and promotion never re-bumps.
     */
    lastStableVersion: string | null;
    /**
     * The branch's current version (e.g. `package.json#version`), used only as
     * the base anchor when `lastStableVersion` is null — i.e. a line that has no
     * stable release yet. A stable `currentVersion` seeds a first release (it is
     * bumped); a pre-release `currentVersion` means we're mid pre-release cycle,
     * so its core is kept as the base (don't re-bump). Ignored once a stable tag
     * exists.
     */
    currentVersion?: string | null;
    /** Aggregated bump since the last stable. Only used by the `semver` scheme. */
    bump: BumpType;
    scheme: VersioningScheme;
    /** Calver pattern; defaults to {@link DEFAULT_CALVER_PATTERN}. */
    pattern?: string | null;
    /**
     * All version strings already cut on this line (stable + pre-release), with
     * any package prefix and leading `v` stripped. Used to DERIVE the next
     * pre-release counter — `max(existing N for this base+suffix) + 1` — so the
     * counter auto-resets to 0 whenever the base bumps or the channel changes.
     */
    knownVersions?: string[];
    /** Injectable `now` (calver / determinism). Defaults to `new Date()`. */
    now?: Date;
}

/**
 * Compute the next version for a release CHANNEL — the channel-aware successor
 * to {@link calculateNextVersion}.
 *
 *   - `stable`     → the clean base version (`0.2.0`, `2026.6.0`, `42`).
 *   - `prerelease` → `{base}-{suffix}.{N}` (`0.2.0-alpha.1`).
 *
 * The base is anchored to `lastStableVersion` (+ `bump` for semver, the date
 * for calver, +1 for incremental). The pre-release counter `N` is derived from
 * `knownVersions`, not stored — see {@link ChannelVersionInput.knownVersions}.
 */
export function computeChannelVersion(input: ChannelVersionInput): string {
    const { channel, lastStableVersion, bump, scheme, knownVersions = [] } = input;
    const now = input.now ?? new Date();
    const pattern = input.pattern ?? null;

    const base = computeBase(
        scheme,
        lastStableVersion,
        input.currentVersion ?? null,
        bump,
        pattern,
        now,
    );

    if (channel.tier === 'stable') return base;

    if (!channel.suffix) {
        throw new Error(
            `Release channel for branch '${channel.branch}' is a pre-release tier but has no suffix.`,
        );
    }
    const n = nextPreReleaseNumber(base, channel.suffix, knownVersions);
    return `${base}-${channel.suffix}.${n}`;
}

/** Strip a leading `v` and any pre-release/build segment, leaving the release core. */
function stripToCore(version: string): string {
    const noV = version.startsWith('v') ? version.slice(1) : version;
    return noV.replace(/[-+].*$/, '');
}

/** Compute the base (stable-target) version for the active scheme. */
function computeBase(
    scheme: VersioningScheme,
    lastStableVersion: string | null,
    currentVersion: string | null,
    bump: BumpType,
    pattern: string | null,
    now: Date,
): string {
    const stable = lastStableVersion ? stripToCore(lastStableVersion) : null;
    const current = currentVersion
        ? currentVersion.startsWith('v')
            ? currentVersion.slice(1)
            : currentVersion
        : null;

    if (scheme === 'semver') {
        if (stable) {
            return bump === 'none' ? stable : nextSemver(stable, bump);
        }
        // No stable release yet — fall back to the current version as anchor.
        if (current) {
            // A pre-release current version means we're mid-cycle for that base;
            // keep the base (the counter will advance). A stable current version
            // seeds a first release and is bumped.
            if (current.includes('-')) return stripToCore(current);
            return bump === 'none' ? stripToCore(current) : nextSemver(stripToCore(current), bump);
        }
        return FIRST_RELEASE_VERSION;
    }
    if (scheme === 'calver') {
        // nextCalver renders fresh (micro 0) when the input is unparseable, so an
        // empty string is the correct "first release" input.
        return nextCalver(
            stable ?? (current ? stripToCore(current) : ''),
            pattern ?? DEFAULT_CALVER_PATTERN,
            now,
        );
    }
    if (scheme === 'incremental') {
        return nextIncremental(stable ?? (current ? stripToCore(current) : '0'));
    }
    const exhaustive: never = scheme;
    throw new Error(`Unknown versioning scheme: ${String(exhaustive)}`);
}

/**
 * Next pre-release counter for `{base}-{suffix}.N`: one past the highest N
 * already present in `knownVersions` for this exact base+suffix, or 0 if none.
 * Deriving from existing versions (rather than a stored counter) is what makes
 * the counter reset automatically on a base bump or a channel change.
 */
function nextPreReleaseNumber(base: string, suffix: string, knownVersions: string[]): number {
    const re = new RegExp(`^${escapeRegex(base)}-${escapeRegex(suffix)}\\.(\\d+)$`);
    let max = -1;
    for (const v of knownVersions) {
        const candidate = v.startsWith('v') ? v.slice(1) : v;
        const m = re.exec(candidate);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
}
