import semver from 'semver';
import {
    DEFAULT_CALVER_PATTERN,
    type BumpType,
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

type CalverToken =
    | 'YYYY'
    | 'YY'
    | '0Y'
    | 'MM'
    | '0M'
    | 'DD'
    | '0D'
    | 'MICRO';

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
    if (!parsed) {
        return renderCalver(compiled, now, 0);
    }

    // Compare each non-MICRO token's value-now against its parsed value.
    // Mismatch in any non-MICRO token resets MICRO to 0.
    const allMatch = compiled.tokenOrder.every((name) => {
        if (name === 'MICRO') return true;
        return resolveToken(name, now, 0) === parsed.fixed[name as NonMicroToken];
    });

    const nextMicro = allMatch ? (parsed.micro ?? 0) + 1 : 0;
    return renderCalver(compiled, now, nextMicro);
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
