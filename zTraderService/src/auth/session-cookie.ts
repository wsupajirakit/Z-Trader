import type { CookieOptions, Request, Response } from 'express';
import { SESSION_ABSOLUTE_MS } from './sessions/session.service';

/**
 * `__Host-` pins the cookie to this exact host, path `/`, and HTTPS (browsers refuse it without Secure).
 * Plain-HTTP local development cannot use the prefix, so it gets the bare name.
 */
const SECURE_NAME = '__Host-zt_session';
const DEV_NAME = 'zt_session';

export type SecureSetting = 'auto' | 'true' | 'false';

export function isSecureRequest(req: Request, setting: SecureSetting): boolean {
    if (setting === 'true') return true;
    if (setting === 'false') return false;
    // req.secure honours X-Forwarded-Proto only when TRUST_PROXY says a proxy is in front
    return req.secure;
}

/** what `SessionService.create` issues: 32 random bytes as base64url (43 chars); a little slack either way */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,64}$/;

/**
 * The session token from the one cookie name this request would be given (see writeSessionCookie).
 * Over HTTPS only `__Host-zt_session` counts: a plain `zt_session` there could have been planted by a
 * sibling subdomain or a plain-HTTP response, which `__Host-` exists to rule out.
 * cookie-parser turns `j:{…}` values into objects, so anything that is not a token-shaped string is
 * treated as no cookie at all.
 */
export function readSessionToken(req: Request, setting: SecureSetting): string | null {
    const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies ?? {};
    const value = cookies[isSecureRequest(req, setting) ? SECURE_NAME : DEV_NAME];
    return typeof value === 'string' && TOKEN_SHAPE.test(value) ? value : null;
}

export function writeSessionCookie(res: Response, req: Request, token: string, setting: SecureSetting) {
    const secure = isSecureRequest(req, setting);
    const opts: CookieOptions = { httpOnly: true, sameSite: 'strict', path: '/', secure, maxAge: SESSION_ABSOLUTE_MS };
    res.cookie(secure ? SECURE_NAME : DEV_NAME, token, opts);
}

export function clearSessionCookie(res: Response) {
    res.clearCookie(SECURE_NAME, { httpOnly: true, sameSite: 'strict', path: '/', secure: true });
    res.clearCookie(DEV_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
}
