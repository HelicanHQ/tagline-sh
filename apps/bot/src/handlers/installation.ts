import type { Context, Probot } from 'probot';
import type { RepoRef } from '~/app/services/github-reader';
import {
    ensureOnboardingPR,
    type EnsureOnboardingResult,
    type OnboardingOctokit,
} from '~/app/services/onboarding';

// See note in handlers/issue-comment.ts on the Octokit type adapter.
const asOnboarding = (octokit: Context['octokit']): OnboardingOctokit =>
    octokit as unknown as OnboardingOctokit;

export type OnboardingOutcome =
    | { repo: RepoRef; result: EnsureOnboardingResult }
    | { repo: RepoRef; error: unknown };

/**
 * Pure-ish core for the onboarding loop: walk the repos and ensure each one
 * has the Configure PR. Errors are caught per-repo so a single 403 doesn't
 * abandon the others — an install that selected 50 repos should still
 * configure the 49 it has access to.
 *
 * Returns the per-repo outcomes so the Probot handler (or tests) can log
 * them. The function never throws.
 */
export async function onboardRepositories(
    octokit: OnboardingOctokit,
    repos: RepoRef[],
): Promise<OnboardingOutcome[]> {
    const outcomes: OnboardingOutcome[] = [];
    for (const repo of repos) {
        try {
            const result = await ensureOnboardingPR(octokit, repo);
            outcomes.push({ repo, result });
        } catch (err) {
            outcomes.push({ repo, error: err });
        }
    }
    return outcomes;
}

/**
 * Map a Probot installation-event repository entry to our `RepoRef`. The
 * event payload gives us `full_name` (`owner/repo`); the App's account login
 * is the owner.
 */
function reposFromInstallation(
    accountLogin: string,
    entries: ReadonlyArray<{ name: string }> | undefined,
): RepoRef[] {
    if (!entries) return [];
    return entries.map((r) => ({ owner: accountLogin, repo: r.name }));
}

/**
 * `installation.created` — App was just installed on N repos. Open the
 * Configure PR on each.
 */
export async function handleInstallationCreated(
    context: Context<'installation.created'>,
): Promise<void> {
    const accountLogin = context.payload.installation.account.login;
    const repos = reposFromInstallation(accountLogin, context.payload.repositories);
    if (repos.length === 0) return;
    const outcomes = await onboardRepositories(asOnboarding(context.octokit), repos);
    logOutcomes(context, outcomes);
}

/**
 * `installation_repositories.added` — App was already installed; user just
 * added more repos. Open the Configure PR on the new ones only. The
 * `repositories_removed` arm is intentionally ignored: deleting onboarding
 * artifacts in repos we no longer have access to isn't safe (and isn't
 * possible without that access).
 */
export async function handleInstallationRepositoriesAdded(
    context: Context<'installation_repositories.added'>,
): Promise<void> {
    const accountLogin = context.payload.installation.account.login;
    const repos = reposFromInstallation(accountLogin, context.payload.repositories_added);
    if (repos.length === 0) return;
    const outcomes = await onboardRepositories(asOnboarding(context.octokit), repos);
    logOutcomes(context, outcomes);
}

function logOutcomes(
    context: { log: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void } },
    outcomes: OnboardingOutcome[],
): void {
    for (const o of outcomes) {
        if ('error' in o) {
            context.log.error({ repo: o.repo, err: o.error }, 'Onboarding PR failed');
            continue;
        }
        switch (o.result.kind) {
            case 'created':
                context.log.info(
                    { repo: o.repo, pr: o.result.prNumber },
                    'Opened onboarding PR',
                );
                break;
            case 'skipped':
                context.log.info(
                    { repo: o.repo, reason: o.result.reason },
                    'Onboarding PR skipped',
                );
                break;
        }
    }
}

export function register(app: Probot): void {
    app.on('installation.created', handleInstallationCreated);
    app.on('installation_repositories.added', handleInstallationRepositoriesAdded);
}
