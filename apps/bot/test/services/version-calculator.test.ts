import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, type ReleaseChannel, type RepoConfig } from '@tagline-sh/shared';
import {
    calculateNextVersion,
    channelForBranch,
    computeChannelVersion,
    stableChannel,
} from '../../src/services/version-calculator.js';

const ALPHA: ReleaseChannel = { branch: 'development', tier: 'prerelease', suffix: 'alpha' };
const RC: ReleaseChannel = { branch: 'staging', tier: 'prerelease', suffix: 'rc' };
const STABLE: ReleaseChannel = { branch: 'main', tier: 'stable', suffix: null };

function calverConfig(pattern: string): RepoConfig {
    return {
        ...DEFAULT_CONFIG,
        versioning: { scheme: 'calver', pattern },
    };
}

function incrementalConfig(): RepoConfig {
    return {
        ...DEFAULT_CONFIG,
        versioning: { scheme: 'incremental', pattern: null },
    };
}

// All calver tests pin `now` so they're deterministic regardless of run date.
const MAY_19_2026 = new Date(Date.UTC(2026, 4, 19, 12, 0, 0));
const JUN_01_2026 = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
const OCT_05_2026 = new Date(Date.UTC(2026, 9, 5, 12, 0, 0));

describe('calculateNextVersion — production branch', () => {
    it('does a clean major bump', () => {
        expect(calculateNextVersion('1.4.2', 'major', 'main', DEFAULT_CONFIG)).toBe('2.0.0');
    });
    it('does a clean minor bump', () => {
        expect(calculateNextVersion('1.4.2', 'minor', 'main', DEFAULT_CONFIG)).toBe('1.5.0');
    });
    it('does a clean patch bump', () => {
        expect(calculateNextVersion('1.4.2', 'patch', 'main', DEFAULT_CONFIG)).toBe('1.4.3');
    });
});

describe('calculateNextVersion — none bump', () => {
    it('returns the input unchanged regardless of branch', () => {
        expect(calculateNextVersion('1.0.0', 'none', 'main', DEFAULT_CONFIG)).toBe('1.0.0');
        expect(calculateNextVersion('1.0.0', 'none', 'staging', DEFAULT_CONFIG)).toBe('1.0.0');
    });
});

describe('calculateNextVersion — pre-release branches', () => {
    it('appends rc.0 on staging branch', () => {
        expect(calculateNextVersion('1.4.2', 'minor', 'staging', DEFAULT_CONFIG)).toBe(
            '1.5.0-rc.0',
        );
    });
    it('appends alpha.0 on dev branch', () => {
        expect(calculateNextVersion('1.4.2', 'minor', 'develop', DEFAULT_CONFIG)).toBe(
            '1.5.0-alpha.0',
        );
    });
    it('honors a custom staging suffix', () => {
        const config = {
            ...DEFAULT_CONFIG,
            preReleaseSuffix: { staging: 'next', development: 'alpha' },
        };
        expect(calculateNextVersion('1.4.2', 'patch', 'staging', config)).toBe('1.4.3-next.0');
    });
});

describe('calculateNextVersion — input validation', () => {
    it('strips a leading v on the input', () => {
        expect(calculateNextVersion('v1.0.0', 'patch', 'main', DEFAULT_CONFIG)).toBe('1.0.1');
    });
    it('throws on invalid semver', () => {
        expect(() =>
            calculateNextVersion('not-a-version', 'patch', 'main', DEFAULT_CONFIG),
        ).toThrow();
    });
});

// --- CalVer ------------------------------------------------------------------

describe('calculateNextVersion — calver YYYY.MM.MICRO', () => {
    const config = calverConfig('YYYY.MM.MICRO');

    it('increments MICRO when same month as last release', () => {
        // last release was 2026.5.0, today is May 19 2026 → 2026.5.1
        expect(calculateNextVersion('2026.5.0', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.5.1',
        );
    });

    it('resets MICRO when month changes', () => {
        // last release was 2026.5.7, today is June 1 2026 → 2026.6.0
        expect(calculateNextVersion('2026.5.7', 'none', 'main', config, JUN_01_2026)).toBe(
            '2026.6.0',
        );
    });

    it('treats unparseable current version as first release', () => {
        expect(calculateNextVersion('whatever', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.5.0',
        );
    });

    it('strips a leading v from the current version before parsing', () => {
        expect(calculateNextVersion('v2026.5.2', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.5.3',
        );
    });
});

describe('calculateNextVersion — calver YYYY.0M.MICRO (zero-padded month) guardrail', () => {
    const config = calverConfig('YYYY.0M.MICRO');

    it('throws when a single-digit month would emit a leading zero (npm-invalid)', () => {
        // May (month 5) under 0M renders `2026.05.1`, which npm rejects.
        expect(() =>
            calculateNextVersion('2026.05.0', 'none', 'main', config, MAY_19_2026),
        ).toThrow(/leading zeros|MM|0M/);
    });

    it('throws on the padded next-month reset too', () => {
        expect(() =>
            calculateNextVersion('2026.05.3', 'none', 'main', config, JUN_01_2026),
        ).toThrow(/not a valid npm/);
    });

    it('still renders when the month is two digits (no leading zero produced)', () => {
        // October (month 10) under 0M renders `2026.10.x` — valid SemVer, so it
        // passes the guardrail. The failure is calendar-dependent by design.
        expect(calculateNextVersion('2026.10.0', 'none', 'main', config, OCT_05_2026)).toBe(
            '2026.10.1',
        );
    });
});

describe('calculateNextVersion — calver appends pre-release suffix on non-prod branches', () => {
    const config = calverConfig('YYYY.MM.MICRO');

    it('appends rc.0 on staging', () => {
        expect(calculateNextVersion('2026.5.0', 'none', 'staging', config, MAY_19_2026)).toBe(
            '2026.5.1-rc.0',
        );
    });

    it('parses past a pre-release suffix on the current version', () => {
        // Suffixed current was a staging release; bumping back to prod drops the suffix.
        expect(calculateNextVersion('2026.5.0-rc.0', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.5.1',
        );
    });
});

describe('calculateNextVersion — calver pattern validation', () => {
    it('throws when pattern lacks MICRO', () => {
        const config = calverConfig('YYYY.MM');
        expect(() => calculateNextVersion('2026.5', 'none', 'main', config, MAY_19_2026)).toThrow(
            /MICRO/,
        );
    });

    it('falls back to the npm-safe default pattern when null', () => {
        // pattern: null → DEFAULT_CALVER_PATTERN ('YYYY.MM.MICRO'), unpadded.
        const config: RepoConfig = {
            ...DEFAULT_CONFIG,
            versioning: { scheme: 'calver', pattern: null },
        };
        expect(calculateNextVersion('2026.5.0', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.5.1',
        );
    });
});

// --- Incremental -------------------------------------------------------------

describe('calculateNextVersion — incremental', () => {
    const config = incrementalConfig();

    it('increments by 1', () => {
        expect(calculateNextVersion('41', 'none', 'main', config)).toBe('42');
    });

    it('strips a leading v', () => {
        expect(calculateNextVersion('v41', 'none', 'main', config)).toBe('42');
    });

    it('starts at 1 when current is unparseable', () => {
        expect(calculateNextVersion('whatever', 'none', 'main', config)).toBe('1');
    });

    it('appends pre-release suffix on staging', () => {
        expect(calculateNextVersion('41', 'none', 'staging', config)).toBe('42-rc.0');
    });
});

// --- Release channels --------------------------------------------------------

describe('channelForBranch / stableChannel', () => {
    it('resolves a branch to its channel', () => {
        expect(channelForBranch(DEFAULT_CONFIG, 'main')).toEqual({
            branch: 'main',
            tier: 'stable',
            suffix: null,
        });
        expect(channelForBranch(DEFAULT_CONFIG, 'develop')).toEqual({
            branch: 'develop',
            tier: 'prerelease',
            suffix: 'alpha',
        });
    });

    it('returns null for a non-channel branch', () => {
        expect(channelForBranch(DEFAULT_CONFIG, 'feature/x')).toBeNull();
    });

    it('finds the stable channel', () => {
        expect(stableChannel(DEFAULT_CONFIG)?.branch).toBe('main');
    });
});

describe('computeChannelVersion — semver gitflow (dev→staging→prod)', () => {
    const common = {
        bump: 'minor' as const,
        scheme: 'semver' as const,
        lastStableVersion: '0.1.1',
    };

    it('alpha: first pre-release of the next minor', () => {
        expect(computeChannelVersion({ ...common, channel: ALPHA, knownVersions: [] })).toBe(
            '0.2.0-alpha.0',
        );
    });

    it('alpha: counter increments while the base is unchanged', () => {
        expect(
            computeChannelVersion({
                ...common,
                channel: ALPHA,
                knownVersions: ['0.2.0-alpha.0', '0.2.0-alpha.1'],
            }),
        ).toBe('0.2.0-alpha.2');
    });

    it('rc: counter resets on channel change (same base, different suffix)', () => {
        expect(
            computeChannelVersion({
                ...common,
                channel: RC,
                knownVersions: ['0.2.0-alpha.0', '0.2.0-alpha.1'],
            }),
        ).toBe('0.2.0-rc.0');
    });

    it('stable: clean version, suffix dropped', () => {
        expect(
            computeChannelVersion({
                ...common,
                channel: STABLE,
                knownVersions: ['0.2.0-alpha.1', '0.2.0-rc.0'],
            }),
        ).toBe('0.2.0');
    });

    it('alpha for the same base always agrees with rc (anchored to last stable)', () => {
        // Whatever channel, the base is 0.2.0 because last stable is 0.1.1 + minor.
        const a = computeChannelVersion({ ...common, channel: ALPHA, knownVersions: [] });
        const r = computeChannelVersion({ ...common, channel: RC, knownVersions: [] });
        expect(a.startsWith('0.2.0-')).toBe(true);
        expect(r.startsWith('0.2.0-')).toBe(true);
    });

    it('counter resets when the base bumps (prior alpha tags are for an older base)', () => {
        // Last stable is now 0.2.0; the next minor base is 0.3.0, so the 0.2.0
        // alphas are irrelevant and the new line starts at alpha.0.
        expect(
            computeChannelVersion({
                channel: ALPHA,
                scheme: 'semver',
                bump: 'minor',
                lastStableVersion: '0.2.0',
                knownVersions: ['0.2.0-alpha.0', '0.2.0-alpha.1', '0.2.0-rc.0'],
            }),
        ).toBe('0.3.0-alpha.0');
    });

    it('first release (no prior stable): 0.1.0 and 0.1.0-alpha.0', () => {
        expect(
            computeChannelVersion({
                channel: STABLE,
                scheme: 'semver',
                bump: 'minor',
                lastStableVersion: null,
            }),
        ).toBe('0.1.0');
        expect(
            computeChannelVersion({
                channel: ALPHA,
                scheme: 'semver',
                bump: 'minor',
                lastStableVersion: null,
            }),
        ).toBe('0.1.0-alpha.0');
    });

    it('ignores known versions for a different suffix or base', () => {
        expect(
            computeChannelVersion({
                ...common,
                channel: ALPHA,
                knownVersions: ['0.2.0-rc.4', '0.1.0-alpha.9', '0.2.0'],
            }),
        ).toBe('0.2.0-alpha.0');
    });
});

describe('computeChannelVersion — calver + incremental channels', () => {
    const JUN_01_2026 = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));

    it('calver stable rolls to the new month, alpha appends the suffix', () => {
        const cal = { scheme: 'calver' as const, bump: 'none' as const, pattern: 'YYYY.MM.MICRO' };
        expect(
            computeChannelVersion({
                ...cal,
                channel: STABLE,
                lastStableVersion: '2026.5.3',
                now: JUN_01_2026,
            }),
        ).toBe('2026.6.0');
        expect(
            computeChannelVersion({
                ...cal,
                channel: ALPHA,
                lastStableVersion: '2026.5.3',
                now: JUN_01_2026,
                knownVersions: ['2026.6.0-alpha.0'],
            }),
        ).toBe('2026.6.0-alpha.1');
    });

    it('incremental stable +1, alpha appends the suffix', () => {
        const inc = { scheme: 'incremental' as const, bump: 'none' as const };
        expect(computeChannelVersion({ ...inc, channel: STABLE, lastStableVersion: '41' })).toBe(
            '42',
        );
        expect(computeChannelVersion({ ...inc, channel: ALPHA, lastStableVersion: '41' })).toBe(
            '42-alpha.0',
        );
    });
});
