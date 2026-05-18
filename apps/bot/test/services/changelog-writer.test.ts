import { describe, it, expect } from 'vitest';
import type { ParsedPR } from '@tagline-sh/shared';
import {
    prependEntryToChangelog,
    renderChangelogEntry,
} from '../../src/services/changelog-writer.js';

const pr = (
    overrides: Partial<ParsedPR> & Pick<ParsedPR, 'number' | 'title' | 'url'>,
): ParsedPR => ({
    author: 'oct',
    mergedAt: '2026-05-17T10:00:00Z',
    commits: [],
    tickets: [],
    suggestedBump: 'patch',
    bodyExcerpt: null,
    body: null,
    ...overrides,
}) as ParsedPR;

describe('renderChangelogEntry', () => {
    it('produces a Keep-a-Changelog formatted entry with the given date', () => {
        const md = renderChangelogEntry({
            version: '1.5.0',
            date: '2026-05-18',
            prs: [
                pr({
                    number: 342,
                    title: 'feat: OAuth2 PKCE',
                    url: 'https://github.com/a/b/pull/342',
                    commits: [
                        {
                            type: 'feat',
                            scope: null,
                            subject: 'OAuth2 PKCE',
                            body: null,
                            isBreaking: false,
                            sha: 'a',
                        },
                    ],
                    tickets: ['PROJ-1201'],
                    suggestedBump: 'minor',
                }),
                pr({
                    number: 341,
                    title: 'fix: race condition',
                    url: 'https://github.com/a/b/pull/341',
                    commits: [
                        {
                            type: 'fix',
                            scope: null,
                            subject: 'race condition',
                            body: null,
                            isBreaking: false,
                            sha: 'b',
                        },
                    ],
                }),
            ],
        });
        expect(md).toContain('## [1.5.0] - 2026-05-18');
        expect(md).toContain('### Added');
        expect(md).toContain('OAuth2 PKCE ([#342]');
        expect(md).toContain('### Fixed');
        expect(md).toContain('race condition ([#341]');
        expect(md).toContain('PROJ-1201');
    });

    it('omits empty sections', () => {
        const md = renderChangelogEntry({
            version: '1.0.1',
            date: '2026-01-01',
            prs: [
                pr({
                    number: 5,
                    title: 'fix: typo',
                    url: 'u',
                    commits: [
                        {
                            type: 'fix',
                            scope: null,
                            subject: 'typo',
                            body: null,
                            isBreaking: false,
                            sha: 'x',
                        },
                    ],
                }),
            ],
        });
        expect(md).not.toContain('### Added');
        expect(md).toContain('### Fixed');
    });

    it('strips leading v from version', () => {
        const md = renderChangelogEntry({ version: 'v2.0.0', date: '2026-01-01', prs: [] });
        expect(md).toContain('## [2.0.0]');
        expect(md).not.toContain('## [v2.0.0]');
    });

    it('routes breaking PRs into Removed', () => {
        const md = renderChangelogEntry({
            version: '2.0.0',
            date: '2026-01-01',
            prs: [
                pr({
                    number: 9,
                    title: 'feat!: drop /v1',
                    url: 'u',
                    commits: [
                        {
                            type: 'feat',
                            scope: null,
                            subject: 'drop /v1',
                            body: null,
                            isBreaking: true,
                            sha: 'q',
                        },
                    ],
                    suggestedBump: 'major',
                }),
            ],
        });
        expect(md).toContain('### Removed');
        expect(md).toContain('drop /v1');
    });
});

describe('prependEntryToChangelog', () => {
    const entry = '## [1.1.0] - 2026-05-18\n\n### Added\n\n- new thing\n';

    it('creates a fresh CHANGELOG with header when none exists', () => {
        const out = prependEntryToChangelog(null, entry);
        expect(out).toContain('# Changelog');
        expect(out).toContain('Keep a Changelog');
        expect(out).toContain('## [1.1.0]');
    });

    it('prepends in front of the first existing entry', () => {
        const existing =
            '# Changelog\n\n' +
            'Some preamble.\n\n' +
            '## [1.0.0] - 2026-01-01\n\n### Added\n\n- initial release\n';
        const out = prependEntryToChangelog(existing, entry);
        const idxNew = out.indexOf('## [1.1.0]');
        const idxOld = out.indexOf('## [1.0.0]');
        expect(idxNew).toBeGreaterThan(-1);
        expect(idxOld).toBeGreaterThan(idxNew);
    });

    it('appends after header when no prior entries exist', () => {
        const out = prependEntryToChangelog('# Changelog\n\nNothing yet.\n', entry);
        expect(out).toContain('## [1.1.0]');
        expect(out.indexOf('## [1.1.0]')).toBeGreaterThan(out.indexOf('Nothing yet.'));
        // Body must follow the header, with a blank line between them.
        expect(out).toMatch(/Nothing yet\.\n\n## \[1\.1\.0\]/);
    });
});
