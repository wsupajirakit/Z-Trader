import { normalizeIp } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Login attempts per client IP per minute, on top of the per-account lockout.
 *
 * `@Throttle()` is evaluated when the controller class is loaded, before ConfigService exists, but it
 * accepts a function for `limit`. So the limit lives in this holder, and AuthService sets it from the
 * validated LOGIN_RATE_LIMIT_PER_MIN when it is constructed (before the first request).
 */
let loginLimitPerMin = 10;

export function setLoginRateLimit(perMin: number | undefined) {
    if (typeof perMin === 'number' && Number.isInteger(perMin) && perMin > 0) loginLimitPerMin = perMin;
}

const TTL_MS = 60_000;

/** browser login and change-password: keyed on the client IP Express resolved (see clientIp) */
export const LOGIN_THROTTLE = { default: { limit: () => loginLimitPerMin, ttl: TTL_MS } };

/**
 * POST /api/v1/auth/verify is called by zTraderActor, so the socket peer is the Actor for every one of
 * its users. Keyed on that, all Actor users would share one 10/min budget, and one person mistyping
 * would lock everybody else out of the Actor.
 *
 * Why keep a throttle keyed on the forwarded `clientIp` instead of removing it: the route already needs
 * the API key, and whoever holds the key could send any `clientIp`. Even so, this keeps the same
 * per-end-user-IP limit that browser login has, as a second layer behind the Actor's own limiter, so
 * an Actor bug that drops its limiter still cannot turn into unlimited password spraying. It is keyed
 * on the IP alone, not IP + username. Per IP + username would let one address try 10 passwords a
 * minute against every account. Per IP caps it at 10 a minute in total, the same as the web form.
 * When the Actor sends no `clientIp`, this falls back to the socket peer (the old shared budget).
 * The body is read before validation here, so anything that is not a short string is ignored.
 */
export function verifyTracker(req: Record<string, unknown>): string {
    const r = req as unknown as Request & { body?: { clientIp?: unknown } };
    const forwarded = r.body?.clientIp;
    if (typeof forwarded === 'string' && forwarded.length > 0 && forwarded.length <= 64) {
        return `actor-client:${normalizeIp(forwarded.trim().toLowerCase())}`;
    }
    return normalizeIp(r.ip ?? r.socket?.remoteAddress ?? 'unknown');
}

export const VERIFY_THROTTLE = { default: { limit: () => loginLimitPerMin, ttl: TTL_MS, getTracker: verifyTracker } };
