import { describe, it, expect } from 'vitest';
import {
    aggregateBumps,
    excerpt,
    extractTickets,
    maxBump,
    releaseBranchName,
    releaseTagName,
} from '../src/utils.js';

describe('extractTickets', () => {
    it('returns [] for empty / falsy input', () => {
        expect(extractTickets('')).toEqual([]);
        expect(extractTickets('   ')).toEqual([]);
    });

    it('finds JIRA-style tickets', () => {
        expect(extractTickets('Fixes PROJ-123 and PROJ-456')).toEqual(['PROJ-123', 'PROJ-456']);
    });

    it('finds Linear-style lowercase tickets', () => {
        expect(extractTickets('closes eng-42 ref eng-43')).toEqual(['eng-42', 'eng-43']);
    });

    it('finds GitHub issue refs', () => {
        expect(extractTickets('fixes #42 closes #1337')).toEqual(['#42', '#1337']);
    });

    it('handles mixed ticket styles in a single string', () => {
        const result = extractTickets('Fixes PROJ-1 and #42 plus eng-7');
        expect(result).toContain('PROJ-1');
        expect(result).toContain('#42');
        expect(result).toContain('eng-7');
        expect(result).toHaveLength(3);
    });

    it('deduplicates repeated tickets', () => {
        expect(extractTickets('PROJ-1, PROJ-1, PROJ-1')).toEqual(['PROJ-1']);
        expect(extractTickets('#42 and #42 again')).toEqual(['#42']);
    });

    it('does not match malformed patterns', () => {
        // Trailing hyphen with no digits, leading digits, etc.
        expect(extractTickets('FOO- and -123 and #')).toEqual([]);
    });
});

describe('releaseBranchName / releaseTagName', () => {
    it('strips a leading v in branch names', () => {
        expect(releaseBranchName('1.2.3')).toBe('release/v1.2.3');
        expect(releaseBranchName('v1.2.3')).toBe('release/v1.2.3');
    });

    it('always prefixes v in tag names', () => {
        expect(releaseTagName('1.2.3')).toBe('v1.2.3');
        expect(releaseTagName('v1.2.3')).toBe('v1.2.3');
    });
});

describe('maxBump / aggregateBumps', () => {
    it('orders bumps major > minor > patch > none', () => {
        expect(maxBump('none', 'patch')).toBe('patch');
        expect(maxBump('patch', 'minor')).toBe('minor');
        expect(maxBump('minor', 'major')).toBe('major');
        expect(maxBump('major', 'patch')).toBe('major');
        expect(maxBump('none', 'none')).toBe('none');
    });

    it('aggregates a list to the highest bump present', () => {
        expect(aggregateBumps(['none', 'patch', 'minor'])).toBe('minor');
        expect(aggregateBumps(['patch', 'patch', 'major'])).toBe('major');
        expect(aggregateBumps([])).toBe('none');
        expect(aggregateBumps(['none'])).toBe('none');
    });
});

describe('excerpt', () => {
    it('returns null for empty / nullish input', () => {
        expect(excerpt(null)).toBeNull();
        expect(excerpt(undefined)).toBeNull();
        expect(excerpt('')).toBeNull();
        expect(excerpt('   ')).toBeNull();
    });

    it('returns the full string when shorter than the limit', () => {
        expect(excerpt('short', 100)).toBe('short');
    });

    it('truncates at a word boundary near the limit and appends an ellipsis', () => {
        const s = 'word '.repeat(200).trim(); // long string of "word"s
        const out = excerpt(s, 50);
        expect(out).not.toBeNull();
        expect(out!.length).toBeLessThanOrEqual(51); // 50 chars + ellipsis
        expect(out!.endsWith('…')).toBe(true);
    });
});
