import { parseCookie } from 'cookie';
import { ABSOLUTE_TTL_MS } from './SessionStore.js';

// Distinct from zTraderService's own `zt_session`: cookies are not isolated by port,
// so both apps on localhost must not share a cookie name.
export const SECURE_COOKIE = '__Host-zta_session';
export const PLAIN_COOKIE = 'zta_session';

/**
 * Whether the request reached us over HTTPS. Mirrors Express's req.protocol logic so the
 * socket.io handshake (a bare IncomingMessage) and Express routes agree.
 * X-Forwarded-Proto is only honoured when TRUST_PROXY > 0.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} trustProxy
 */
export function isSecureRequest(req, trustProxy) {
    if (req.socket?.encrypted) return true;
    if (trustProxy > 0) {
        const proto = String(req.headers['x-forwarded-proto'] ?? '')
            .split(',')[0]
            .trim()
            .toLowerCase();
        return proto === 'https';
    }
    return false;
}

export const cookieName = (secure) => (secure ? SECURE_COOKIE : PLAIN_COOKIE);

/** Reads the session token from the cookie that matches the transport (never the other one). */
export function readSessionToken(req, secure) {
    const header = req.headers.cookie;
    if (!header) return undefined;
    return parseCookie(header)[cookieName(secure)];
}

export function cookieOptions(secure) {
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: '/',
        maxAge: ABSOLUTE_TTL_MS,
    };
}
