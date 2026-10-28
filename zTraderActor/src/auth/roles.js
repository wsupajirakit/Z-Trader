export const ROLES = Object.freeze(['viewer', 'operator', 'admin']);

const RANK = { viewer: 1, operator: 2, admin: 3 };

/** `viewer` reads; `operator` and `admin` may also trade and change settings. */
export function hasRole(user, minimum) {
    return Boolean(user) && (RANK[user.role] ?? 0) >= RANK[minimum];
}

export const UNVERIFIED_MESSAGE =
    'zTraderService cannot be reached to confirm your account, so trading actions are paused. Reading still works.';

/**
 * Single authorisation rule for HTTP and socket actions.
 * Above `viewer`, the session must also have passed its latest re-check against
 * zTraderService (fail closed for writes; reads stay available while the service is down).
 *
 * @returns {{ ok: true } | { ok: false, status: 403 | 503, error: string }}
 */
export function authorize(session, minimum) {
    if (!session || !hasRole(session.user, minimum)) {
        return { ok: false, status: 403, error: `requires role ${minimum} or higher` };
    }
    if (minimum !== 'viewer' && !session.verified) return { ok: false, status: 503, error: UNVERIFIED_MESSAGE };
    return { ok: true };
}
