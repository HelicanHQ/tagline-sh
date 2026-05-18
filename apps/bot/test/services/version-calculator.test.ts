import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '@tagline-sh/shared';
import { calculateNextVersion } from '../../src/services/version-calculator.js';

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
