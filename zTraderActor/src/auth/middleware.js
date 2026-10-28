import { timingSafeEqual } from 'node:crypto';
import { cookieName, cookieOptions, isSecureRequest, readSessionToken } from './cookies.js';
import { authorize } from './roles.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when the request is same-origin, or carries no browser origin information at all
 * (curl, server-to-server). A present `Origin` must match the Host header; `Origin: null`
 * and cross-site `Sec-Fetch-Site` are rejected.
 *
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {string | undefined} host  host[:port] the client addressed
 */
export function isSameOrigin(headers, host) {
    const origin = headers.origin;
    if (origin !== undefined) {
        if (!host) return false;
        try {
            return new URL(origin).host === host.toLowerCase();
        } catch {
            return false; // includes the literal "null" origin
        }
    }
    const site = headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
}

/** Host the browser used. Behind a trusted proxy that is X-Forwarded-Host when present. */
export function requestHost(req, trustProxy) {
    const forwarded = trustProxy > 0 ? req.headers['x-forwarded-host'] : undefined;
    const host = forwarded ? String(forwarded).split(',')[0].trim() : req.headers.host;
    return host?.toLowerCase();
}

/** Rejects writes (any non-GET/HEAD/OPTIONS) from another origin. Runs before login too. */
export function originGuard(trustProxy) {
    return (req, res, next) => {
        if (SAFE_METHODS.has(req.method) || isSameOrigin(req.headers, requestHost(req, trustProxy))) return next();
        res.status(403).json({ error: 'cross-origin request rejected' });
    };
}

/**
 * Attaches `req.auth = { session, user, secure }` when the session cookie is valid.
 * A session that is due is first re-checked against zTraderService (at most once per 60 s),
 * so a disable or demotion made on the main dashboard applies here too.
 *
 * @param {import('./SessionStore.js').SessionStore} sessions
 * @param {import('./SessionRevalidator.js').SessionRevalidator} revalidator
 * @param {number} trustProxy
 */
export function loadSession(sessions, revalidator, trustProxy) {
    return async (req, res, next) => {
        const secure = isSecureRequest(req, trustProxy);
        const token = readSessionToken(req, secure);
        let session = token ? sessions.get(token) : null;
        if (session) {
            await revalidator.refresh(session);
            if (!sessions.isActive(session, { touch: false })) session = null;
        }
        req.auth = { secure, session, user: session?.user ?? null };
        if (token && !session) {
            // stale cookie (expired, revoked, or the process restarted)
            res.clearCookie(cookieName(secure), cookieOptions(secure));
        }
        next();
    };
}

export function requireAuth(req, res, next) {
    if (req.auth?.session) return next();
    res.status(401).json({ error: 'authentication required' });
}

export function requireRole(minimum) {
    return (req, res, next) => {
        const result = authorize(req.auth?.session, minimum);
        if (result.ok) return next();
        res.status(result.status).json({ error: result.error });
    };
}

/** Synchronizer-token CSRF check: the per-session token must come back in X-CSRF-Token. */
export function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const expected = req.auth?.session?.csrfToken;
    const given = req.get('x-csrf-token');
    if (expected && typeof given === 'string' && safeEqual(given, expected)) return next();
    res.status(403).json({ error: 'missing or invalid CSRF token' });
}

function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
