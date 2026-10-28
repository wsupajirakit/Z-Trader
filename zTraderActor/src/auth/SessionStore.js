import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
export const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_SESSIONS_PER_USER = 10;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url'); // 256 bits

/**
 * @typedef {object} SessionUser
 * @property {string} id
 * @property {string} username
 * @property {string} name
 * @property {'viewer' | 'operator' | 'admin'} role
 *
 * @typedef {object} Session
 * @property {string} id          random id, safe to log and to use as a socket room name
 * @property {string} hash        SHA-256 of the cookie token (map key)
 * @property {SessionUser} user
 * @property {string} csrfToken   fixed for the life of the session
 * @property {number} createdAt
 * @property {number} lastSeenAt
 * @property {number} expiresAt   absolute expiry
 * @property {number} checkedAt   last successful-or-attempted re-check against zTraderService
 * @property {boolean} verified   false while the last re-check could not reach the service
 * @property {string} [ip]
 * @property {string} [userAgent]
 */

/**
 * In-memory session store. Single instance only: a restart (or a second replica) means
 * everyone has to log in again. The cookie holds a random 256-bit token; the map is keyed
 * by its SHA-256, so the raw token never sits in the store.
 *
 * Emits `end` (session) when a session is revoked or expires, so open sockets can be closed.
 */
export class SessionStore extends EventEmitter {
    /**
     * @param {{ now?: () => number, absoluteTtlMs?: number, idleTtlMs?: number }} [opts]
     */
    constructor({ now = Date.now, absoluteTtlMs = ABSOLUTE_TTL_MS, idleTtlMs = IDLE_TTL_MS } = {}) {
        super();
        this.now = now;
        this.absoluteTtlMs = absoluteTtlMs;
        this.idleTtlMs = idleTtlMs;
        /** @type {Map<string, Session>} */
        this.sessions = new Map();
        this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        this.sweeper.unref();
    }

    /**
     * @param {SessionUser} user
     * @param {{ ip?: string, userAgent?: string }} [meta]
     * @returns {{ token: string, session: Session }}
     */
    create(user, meta = {}) {
        this.enforcePerUserLimit(user.id);
        const token = newToken();
        const now = this.now();
        const session = {
            id: randomUUID(),
            hash: sha256(token),
            user: Object.freeze({ ...user }),
            csrfToken: newToken(),
            createdAt: now,
            lastSeenAt: now,
            expiresAt: now + this.absoluteTtlMs,
            checkedAt: now, // the login itself was just verified by the service
            verified: true,
            ip: meta.ip,
            userAgent: meta.userAgent,
        };
        this.sessions.set(session.hash, session);
        return { token, session };
    }

    /** Looks up a session by raw cookie token and refreshes its idle timer. */
    get(token, { touch = true } = {}) {
        if (typeof token !== 'string' || token.length === 0 || token.length > 128) return null;
        const session = this.sessions.get(sha256(token));
        return session ? this.validate(session, touch) : null;
    }

    /** Re-checks a session object held elsewhere (e.g. by a socket). */
    isActive(session, { touch = true } = {}) {
        return this.sessions.get(session?.hash) === session && this.validate(session, touch) !== null;
    }

    validate(session, touch) {
        const now = this.now();
        if (now >= session.expiresAt || now - session.lastSeenAt >= this.idleTtlMs) {
            this.end(session);
            return null;
        }
        if (touch) session.lastSeenAt = now;
        return session;
    }

    /** Replaces the cached user (e.g. after a role change made on the main dashboard). */
    updateUser(session, user) {
        session.user = Object.freeze({ ...user });
    }

    /** Live sessions, for periodic re-checks. */
    list() {
        return [...this.sessions.values()];
    }

    revoke(session) {
        if (session && this.sessions.get(session.hash) === session) this.end(session);
    }

    end(session) {
        this.sessions.delete(session.hash);
        this.emit('end', session);
    }

    enforcePerUserLimit(userId) {
        const own = [...this.sessions.values()].filter((s) => s.user.id === userId);
        own.sort((a, b) => a.createdAt - b.createdAt);
        while (own.length >= MAX_SESSIONS_PER_USER) this.end(own.shift());
    }

    sweep() {
        for (const session of this.sessions.values()) this.validate(session, false);
    }

    get size() {
        return this.sessions.size;
    }

    close() {
        clearInterval(this.sweeper);
        this.sessions.clear();
    }
}
