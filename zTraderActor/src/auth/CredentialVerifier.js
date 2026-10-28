import { parseBody } from '../services/ServiceClient.js';
import { ROLES } from './roles.js';

const VERIFY_TIMEOUT_MS = 10000;

/**
 * Checks a username/password against zTraderService (`POST /api/v1/auth/verify`).
 * Users, password hashing, lockout and the audit trail all live in the service.
 *
 * Result:
 *   { ok: true, user }                       user = { id, username, name, role, mustChangePassword }
 *   { ok: false, status: 401 }                bad password, unknown, disabled or locked account
 *   { ok: false, status: 429, retryAfterSec }  rate limited by the service
 * Throws ServiceError when the service is unreachable or answers unexpectedly.
 */
export class CredentialVerifier {
    /** @param {import('../services/ServiceClient.js').ServiceClient} api */
    constructor(api) {
        this.api = api;
    }

    async verify({ username, password, clientIp, userAgent }) {
        const res = await this.api.raw('POST', '/api/v1/auth/verify', {
            body: { username, password, clientIp, userAgent },
            timeoutMs: VERIFY_TIMEOUT_MS,
        });
        const data = await parseBody(res);

        if (res.status === 401) return { ok: false, status: 401 };
        if (res.status === 429) {
            const retryAfterSec = Number(data?.retryAfterSec);
            return {
                ok: false,
                status: 429,
                retryAfterSec: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.ceil(retryAfterSec) : 60,
            };
        }
        if (res.status !== 200) {
            throw new Error(`auth verify returned unexpected status ${res.status}`);
        }

        const u = data?.user;
        if (!u || typeof u.id !== 'string' || typeof u.username !== 'string' || !ROLES.includes(u.role)) {
            throw new Error('auth verify returned a malformed user');
        }
        // The service should never verify a disabled user; treat it as a failed login if it does.
        if (u.disabled === true) return { ok: false, status: 401 };
        return {
            ok: true,
            user: {
                id: u.id,
                username: u.username,
                name: typeof u.name === 'string' ? u.name : u.username,
                role: u.role,
                mustChangePassword: u.mustChangePassword === true,
            },
        };
    }
}
