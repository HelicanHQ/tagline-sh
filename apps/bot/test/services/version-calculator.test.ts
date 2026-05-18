import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, type RepoConfig } from '@tagline-sh/shared';
import { calculateNextVersion } from '../../src/services/version-calculator.js';

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
        expect(calculateNextVersion('1.4.2', 'minor', 'staging', DEFAULT_CONFIG)).toBe('1.5.0-rc.0');
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
        expect(() => calculateNextVersion('not-a-version', 'patch', 'main', DEFAULT_CONFIG)).toThrow();
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

describe('calculateNextVersion — calver YYYY.0M.MICRO (zero-padded month)', () => {
    const config = calverConfig('YYYY.0M.MICRO');

    it('renders MICRO bump with padded month', () => {
        // last release 2026.05.0 in May → 2026.05.1 (same month)
        expect(calculateNextVersion('2026.05.0', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.05.1',
        );
    });

    it('renders padded next-month reset', () => {
        expect(calculateNextVersion('2026.05.3', 'none', 'main', config, JUN_01_2026)).toBe(
            '2026.06.0',
        );
    });

    it('detects pattern change (0M ≠ MM): treats parse failure as first release', () => {
        // current was written with unpadded `MM`; pattern now expects `0M`.
        expect(calculateNextVersion('2026.5.4', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.05.0',
        );
    });
});

describe('calculateNextVersion — calver appends pre-release suffix on non-prod branches', () => {
    const config = calverConfig('YYYY.0M.MICRO');

    it('appends rc.0 on staging', () => {
        expect(calculateNextVersion('2026.05.0', 'none', 'staging', config, MAY_19_2026)).toBe(
            '2026.05.1-rc.0',
        );
    });

    it('parses past a pre-release suffix on the current version', () => {
        // Suffixed current was a staging release; bumping back to prod drops the suffix.
        expect(calculateNextVersion('2026.05.0-rc.0', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.05.1',
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

    it('falls back to default pattern when null', () => {
        // pattern: null → DEFAULT_CALVER_PATTERN ('YYYY.0M.MICRO')
        const config: RepoConfig = {
            ...DEFAULT_CONFIG,
            versioning: { scheme: 'calver', pattern: null },
        };
        expect(calculateNextVersion('2026.05.0', 'none', 'main', config, MAY_19_2026)).toBe(
            '2026.05.1',
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
