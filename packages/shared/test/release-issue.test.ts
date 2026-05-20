import { describe, it, expect } from 'vitest';
import {
    RELEASE_ISSUE_LABEL,
    buildReleaseIssueClosingCommentBody,
    buildReleaseIssueMonorepoClosingCommentBody,
    encodeReleaseIssueMarker,
    extractReleaseIssueMarker,
} from '../src/release-issue.js';

describe('release-issue constants', () => {
    it('exports the canonical label name (must not change without a migration)', () => {
        // Changing this label name silently breaks every existing repo's
        // open release issue. Treat as a load-bearing string constant.
        expect(RELEASE_ISSUE_LABEL).toBe('tagline:release-pending');
    });
});

describe('encodeReleaseIssueMarker / extractReleaseIssueMarker', () => {
    it('round-trips a marker through encode + extract', () => {
        const original = { v: 1 as const, branch: 'main', lastTag: 'v0.5.0' };
        const encoded = encodeReleaseIssueMarker(original);
        expect(extractReleaseIssueMarker(encoded)).toEqual(original);
    });

    it('returns null for unknown schema versions (forward-compat guard)', () => {
        // If a future v2 schema lands while a v1 bot is still deployed, the
        // v1 bot must NOT mis-parse v2 as v1 and act on it.
        const future = '<!-- tagline-issue-v1 {"v":2,"branch":"main"} -->';
        expect(extractReleaseIssueMarker(future)).toBeNull();
    });

    it('returns null for malformed JSON', () => {
        expect(extractReleaseIssueMarker('<!-- tagline-issue-v1 {bad -->')).toBeNull();
    });

    it('returns null when the marker is opened but never closed', () => {
        expect(
            extractReleaseIssueMarker('<!-- tagline-issue-v1 {"v":1,"branch":"main"}'),
        ).toBeNull();
    });
});

describe('buildReleaseIssueClosingCommentBody', () => {
    it('renders the tag, release URL, and Ready-to-share block in order', () => {
        const body = buildReleaseIssueClosingCommentBody({
            tagName: 'v1.5.0',
            releaseUrl: 'https://github.com/acme/widget/releases/tag/v1.5.0',
            readyToShareMarkdown: '## v1.5.0\n\n- New feature',
        });
        expect(body).toMatch(/^Released `v1\.5\.0` 🎉/);
        expect(body).toContain('https://github.com/acme/widget/releases/tag/v1.5.0');
        expect(body).toContain('**Ready to share:**');
        expect(body).toContain('- New feature');
        // Tag heading appears before "Ready to share" section, which appears
        // before the actual paste artifact.
        const tagIdx = body.indexOf('v1.5.0');
        const readyIdx = body.indexOf('Ready to share');
        const payloadIdx = body.indexOf('- New feature');
        expect(tagIdx).toBeLessThan(readyIdx);
        expect(readyIdx).toBeLessThan(payloadIdx);
    });
});

describe('buildReleaseIssueMonorepoClosingCommentBody', () => {
    it('renders each tag with its release URL', () => {
        const body = buildReleaseIssueMonorepoClosingCommentBody({
            tags: ['@acme/api@1.1.0', '@acme/ui@0.5.1'],
            releaseUrls: ['url-api', 'url-ui'],
            readyToShareMarkdown: '## Release\n\n- stuff',
        });
        expect(body).toContain('Released 2 packages 🎉');
        expect(body).toContain('- `@acme/api@1.1.0` → url-api');
        expect(body).toContain('- `@acme/ui@0.5.1` → url-ui');
    });

    it('renders "already released, skipped" for tags whose release URL is null (idempotent re-run)', () => {
        const body = buildReleaseIssueMonorepoClosingCommentBody({
            tags: ['@acme/api@1.1.0', '@acme/ui@0.5.1'],
            releaseUrls: ['url-api', null], // ui release pre-existed
            readyToShareMarkdown: '## Release',
        });
        expect(body).toContain('- `@acme/api@1.1.0` → url-api');
        expect(body).toContain('- `@acme/ui@0.5.1` (already released, skipped)');
    });
});
