import type { Octokit } from 'octokit';

/** Minimum Octokit shape this util needs — accepts both bare and Probot Octokit. */
export type PermissionsOctokit = Pick<Octokit, 'rest'>;

/**
 * Check whether `username` has at least `write` access to `repo`. We accept
 * `write`, `maintain`, and `admin` — `triage` and `read` are not enough to
 * trigger a release.
 *
 * Returns `false` (rather than throwing) on permission lookup errors so the
 * bot fails closed: an actor who can't be verified is denied.
 */
export async function checkWritePermission(
    octokit: PermissionsOctokit,
    repo: { owner: string; repo: string },
    username: string,
): Promise<boolean> {
    try {
        const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: repo.owner,
            repo: repo.repo,
            username,
        });
        return ['write', 'maintain', 'admin'].includes(data.permission);
    } catch {
        return false;
    }
}
