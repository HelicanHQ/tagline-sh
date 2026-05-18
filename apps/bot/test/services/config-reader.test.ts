import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '@tagline-sh/shared';
import { readRepoConfig } from '../../src/services/config-reader.js';
import { ANY_REPO, FakeGitHubReader } from '../fixtures/fake-reader.js';

const FULL_CONFIG = `# Release Agent Configuration

## Branches

- production: main
- staging: staging
- development: develop

## Pre-release Tags

- staging suffix: rc
- development suffix: alpha

## Release Notes Style

Write release notes for a technical audience. Be concise.

## Scope Notes

This is a Node.js API service.
`;

describe('readRepoConfig', () => {
    it('returns DEFAULT_CONFIG when the file is absent', async () => {
        const reader = new FakeGitHubReader({});
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg).toEqual(DEFAULT_CONFIG);
    });

    it('parses branch overrides', async () => {
        const reader = new FakeGitHubReader({
            files: { '.release-agent.md': FULL_CONFIG },
        });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.branches.production).toBe('main');
        expect(cfg.branches.staging).toBe('staging');
        expect(cfg.branches.development).toBe('develop');
    });

    it('parses pre-release suffixes', async () => {
        const reader = new FakeGitHubReader({
            files: { '.release-agent.md': FULL_CONFIG },
        });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.preReleaseSuffix.staging).toBe('rc');
        expect(cfg.preReleaseSuffix.development).toBe('alpha');
    });

    it('captures release notes style verbatim', async () => {
        const reader = new FakeGitHubReader({
            files: { '.release-agent.md': FULL_CONFIG },
        });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.releaseNotesStyle).toContain('technical audience');
    });

    it('captures unknown sections as customContext', async () => {
        const reader = new FakeGitHubReader({
            files: { '.release-agent.md': FULL_CONFIG },
        });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.customContext).toContain('Scope Notes');
        expect(cfg.customContext).toContain('Node.js API service');
    });

    it('falls back to defaults for missing branch lines', async () => {
        const partial = `## Branches\n\n- production: trunk\n`;
        const reader = new FakeGitHubReader({
            files: { '.release-agent.md': partial },
        });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.branches.production).toBe('trunk');
        expect(cfg.branches.staging).toBe(DEFAULT_CONFIG.branches.staging);
        expect(cfg.branches.development).toBe(DEFAULT_CONFIG.branches.development);
    });

    it('preserves rawContent', async () => {
        const reader = new FakeGitHubReader({
            files: { '.release-agent.md': FULL_CONFIG },
        });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.rawContent).toBe(FULL_CONFIG);
    });

    it('defaults versioning.scheme to semver when no Versioning section', async () => {
        const reader = new FakeGitHubReader({
            files: { '.release-agent.md': FULL_CONFIG },
        });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.versioning).toEqual({ scheme: 'semver', pattern: null });
    });

    it('parses a calver Versioning section', async () => {
        const md = `## Versioning\n\n- scheme: calver\n- pattern: YYYY.0M.MICRO\n`;
        const reader = new FakeGitHubReader({ files: { '.release-agent.md': md } });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.versioning).toEqual({ scheme: 'calver', pattern: 'YYYY.0M.MICRO' });
    });

    it('parses an incremental Versioning section', async () => {
        const md = `## Versioning\n\n- scheme: incremental\n`;
        const reader = new FakeGitHubReader({ files: { '.release-agent.md': md } });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.versioning).toEqual({ scheme: 'incremental', pattern: null });
    });

    it('falls back to semver for an unknown scheme value', async () => {
        const md = `## Versioning\n\n- scheme: bogus\n`;
        const reader = new FakeGitHubReader({ files: { '.release-agent.md': md } });
        const cfg = await readRepoConfig(reader, ANY_REPO);
        expect(cfg.versioning.scheme).toBe('semver');
    });
});
