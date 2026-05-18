import { describe, it, expect, vi } from 'vitest';
import { checkWritePermission } from '../../src/utils/permissions.js';

function octokitWith(level: string | null) {
    return {
        rest: {
            repos: {
                getCollaboratorPermissionLevel:
                    level === null
                        ? vi.fn(async () => {
                              throw new Error('404');
                          })
                        : vi.fn(async () => ({ data: { permission: level } })),
            },
        },
    } as unknown as Parameters<typeof checkWritePermission>[0];
}

describe('checkWritePermission', () => {
    it.each(['write', 'maintain', 'admin'])('allows %s', async (level) => {
        const ok = await checkWritePermission(octokitWith(level), { owner: 'a', repo: 'b' }, 'u');
        expect(ok).toBe(true);
    });

    it.each(['read', 'triage'])('denies %s', async (level) => {
        const ok = await checkWritePermission(octokitWith(level), { owner: 'a', repo: 'b' }, 'u');
        expect(ok).toBe(false);
    });

    it('fails closed when the lookup throws', async () => {
        const ok = await checkWritePermission(octokitWith(null), { owner: 'a', repo: 'b' }, 'u');
        expect(ok).toBe(false);
    });
});
