/* eslint-disable no-console */
// Phase 2 verification artifact. Composes every service end-to-end against an
// in-memory fixture and prints a full `ReleaseReport` to stdout.
//
// Requires `tsx` (added in Phase 4 dev tooling):
//   pnpm --filter @tagline-sh/bot exec tsx scripts/dry-report.ts
//
// Until Phase 4, the service composition is exercised end-to-end by the
// 52-test bot service suite (`pnpm --filter @tagline-sh/bot test`).
// Phase 3 will introduce a real-GitHub variant of this script that swaps the
// FakeGitHubReader for a live Octokit-backed implementation.
import type { ReleaseReport } from '@tagline-sh/shared';
import { attributePRsToPackages, detectMonorepo } from '../src/services/monorepo-detector.js';
import { readRepoConfig } from '../src/services/config-reader.js';
import { aggregatePRBumps, parsePR } from '../src/services/commit-parser.js';
import { calculateNextVersion } from '../src/services/version-calculator.js';
import { deterministicReport } from '../src/services/report-generator.js';
import { FakeGitHubReader, ANY_REPO } from '../test/fixtures/fake-reader.js';

async function main(): Promise<void> {
    const reader = new FakeGitHubReader({
        files: {
            'package.json': JSON.stringify({ name: 'demo', version: '1.4.2' }),
            'CHANGELOG.md': '# Changelog\n\n## [1.4.2] - 2026-04-28\n\n### Fixed\n\n- old fix\n',
        },
        tags: [{ name: 'v1.4.2', sha: 'abc', commitDate: '2026-04-28T00:00:00Z' }],
        defaultBranch: 'main',
        mergedPRs: [
            {
                number: 342,
                title: 'feat(api): OAuth2 PKCE support',
                body: 'Closes PROJ-1201. Adds RFC 7636 PKCE flow.',
                url: 'https://github.com/demo/repo/pull/342',
                author: 'octocat',
                mergedAt: '2026-05-10T10:00:00Z',
                baseRef: 'main',
                headRef: 'feature/pkce',
            },
            {
                number: 341,
                title: 'fix: token refresh race',
                body: 'Fixes PROJ-1199',
                url: 'https://github.com/demo/repo/pull/341',
                author: 'octocat',
                mergedAt: '2026-05-12T11:00:00Z',
                baseRef: 'main',
                headRef: 'fix/refresh',
            },
        ],
        prCommits: {
            342: [{ sha: 'c1', message: 'feat(api): OAuth2 PKCE support', author: 'octocat' }],
            341: [{ sha: 'c2', message: 'fix: token refresh race', author: 'octocat' }],
        },
    });

    const config = await readRepoConfig(reader, ANY_REPO);
    const monorepo = await detectMonorepo(reader, ANY_REPO);

    const summaries = await reader.listMergedPRs(ANY_REPO, 'main', '2026-04-28T00:00:00Z');
    const parsed = await Promise.all(
        summaries.map(async (summary) => {
            const commits = await reader.listPRCommits(ANY_REPO, summary.number);
            return parsePR(summary, commits).pr;
        }),
    );

    const _attributed = attributePRsToPackages(
        monorepo,
        parsed.map((pr) => ({ pr, files: [] })),
    );

    const suggestedBump = aggregatePRBumps(parsed);
    const currentVersion = '1.4.2';
    const suggestedVersion = calculateNextVersion(currentVersion, suggestedBump, 'main', config);

    const ai = deterministicReport({ prs: parsed, suggestedBump, suggestedVersion, config });

    const report: ReleaseReport = {
        repoOwner: ANY_REPO.owner,
        repoName: ANY_REPO.repo,
        baseBranch: 'main',
        lastTag: 'v1.4.2',
        lastTagDate: '2026-04-28T00:00:00Z',
        prs: parsed,
        suggestedBump,
        suggestedVersion,
        currentVersion,
        reasoning: ai.reasoning,
        changelogPreview: ai.changelogPreview,
        isMonorepo: monorepo.type !== 'none',
        monorepoInfo: monorepo.type === 'none' ? null : monorepo,
        generatedAt: new Date().toISOString(),
        versioningScheme: 'semver',
    };

    console.log(JSON.stringify(report, null, 2));
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
