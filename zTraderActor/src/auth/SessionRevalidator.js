import { log } from '../logging/logger.js';
import { parseBody } from '../services/ServiceClient.js';
import { ROLES } from './roles.js';

export const RECHECK_INTERVAL_MS = 60 * 1000;
const RECHECK_TIMEOUT_MS = 5000;

/**
 * Keeps Actor sessions in line with the user record in zTraderService
 * (`GET /api/v1/auth/users/:id`, x-api-key). Each session is re-checked at most once per
 * RECHECK_INTERVAL_MS: lazily when it is used (HTTP request, socket handshake or event),
 * and by a periodic sweep so idle sessions are cleaned up too.
 *
 *   404 / 400 (unknown, disabled, bad id)       -> revoke (its sockets are disconnected)
 *   mustChangePassword, or passwordChangedAt
 *     later than the session's creation         -> revoke
 *   role / name changed                         -> update the session in place
 *   service unreachable or unexpected answer    -> keep the session but mark it unverified:
 *                                                  reads still work, operator actions are
 *                                                  refused until a later re-check succeeds
 */
export class SessionRevalidator {
    /**
     * @param {{
     *   api: import('../services/ServiceClient.js').ServiceClient,
     *   sessions: import('./SessionStore.js').SessionStore,
     *   now?: () => number,
     *   intervalMs?: number,
     * }} deps
     */
    constructor({ api, sessions, now = Date.now, intervalMs = RECHECK_INTERVAL_MS }) {
        this.api = api;
        this.sessions = sessions;
        this.now = now;
        this.intervalMs = intervalMs;
        /** @type {Map<string, Promise<void>>} session.id -> in-flight check (single-flight) */
        this.inFlight = new Map();
        this.timer = setInterval(() => void this.sweep(), intervalMs);
        this.timer.unref();
    }

    /** Re-checks the session if it is due. Never throws. Resolves when the check is done. */
    refresh(session) {
        if (this.now() - session.checkedAt < this.intervalMs) return Promise.resolve();
        let pending = this.inFlight.get(session.id);
        if (!pending) {
            pending = this.check(session).finally(() => this.inFlight.delete(session.id));
            this.inFlight.set(session.id, pending);
        }
        return pending;
    }

    /** Re-checks every live session that is due. */
    async sweep() {
        for (const session of this.sessions.list()) {
            if (this.sessions.isActive(session, { touch: false })) await this.refresh(session);
        }
    }

    async check(session) {
        const outcome = await this.fetchUser(session.user.id);
        session.checkedAt = this.now();
        if (!this.sessions.isActive(session, { touch: false })) return; // ended meanwhile

        if (outcome.kind === 'unavailable') {
            if (session.verified) {
                log.warn(`session re-check for "${session.user.username}" failed (${outcome.reason}); writes disabled`);
            }
            session.verified = false;
            return;
        }
        if (outcome.kind === 'gone') {
            log.info(`session of "${session.user.username}" revoked: user unknown or disabled in zTraderService`);
            return this.sessions.revoke(session);
        }

        const { user, passwordChangedAt } = outcome;
        const changedAt = passwordChangedAt ? Date.parse(passwordChangedAt) : NaN;
        if (user.mustChangePassword === true || (Number.isFinite(changedAt) && changedAt > session.createdAt)) {
            log.info(`session of "${session.user.username}" revoked: password changed or reset`);
            return this.sessions.revoke(session);
        }

        const current = session.user;
        if (user.role !== current.role || user.name !== current.name || user.username !== current.username) {
            if (user.role !== current.role) {
                log.info(`role of "${user.username}" changed ${current.role} -> ${user.role}; session updated`);
            }
            this.sessions.updateUser(session, {
                id: current.id,
                username: user.username,
                name: user.name,
                role: user.role,
            });
        }
        session.verified = true;
    }

    /** @returns {Promise<{kind:'ok', user, passwordChangedAt}|{kind:'gone'}|{kind:'unavailable', reason:string}>} */
    async fetchUser(id) {
        let res;
        let data;
        try {
            res = await this.api.raw('GET', `/api/v1/auth/users/${encodeURIComponent(id)}`, {
                timeoutMs: RECHECK_TIMEOUT_MS,
            });
            data = await parseBody(res);
        } catch (err) {
            return { kind: 'unavailable', reason: err.code ?? err.message };
        }
        if (res.status === 404 || res.status === 400) return { kind: 'gone' };
        if (res.status !== 200) return { kind: 'unavailable', reason: `HTTP ${res.status}` };

        const u = data?.user;
        if (!u || u.id !== id || typeof u.username !== 'string' || !ROLES.includes(u.role)) {
            return { kind: 'unavailable', reason: 'malformed user record' };
        }
        if (u.disabled === true) return { kind: 'gone' };
        return {
            kind: 'ok',
            user: {
                username: u.username,
                name: typeof u.name === 'string' ? u.name : u.username,
                role: u.role,
                mustChangePassword: u.mustChangePassword === true,
            },
            passwordChangedAt: typeof data.passwordChangedAt === 'string' ? data.passwordChangedAt : null,
        };
    }

    close() {
        clearInterval(this.timer);
    }
}
