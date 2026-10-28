import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { cookieName, cookieOptions } from '../../auth/cookies.js';
import { csrfGuard, requireAuth } from '../../auth/middleware.js';
import { log } from '../../logging/logger.js';
import { loginBody, USERNAME_PATTERN } from '../validation.js';

export const PASSWORD_CHANGE_MESSAGE =
    'You must change your password on the main zTraderService dashboard before you can sign in here.';

const TOO_MANY_ATTEMPTS = 'too many attempts, try again later';

const publicUser = ({ id, username, name, role }) => ({ id, username, name, role });

/**
 * POST /login, GET /me, POST /logout.
 *
 * @param {{
 *   sessions: import('../../auth/SessionStore.js').SessionStore,
 *   verifier: import('../../auth/CredentialVerifier.js').CredentialVerifier,
 *   loginRateLimit: { windowMs: number, limit: number },
 * }} deps
 */
export function authRoutes({ sessions, verifier, loginRateLimit }) {
    const router = Router();

    // Counts failed attempts per client IP (the service additionally locks the account).
    const loginLimiter = rateLimit({
        windowMs: loginRateLimit.windowMs,
        limit: loginRateLimit.limit,
        skipSuccessfulRequests: true,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res) => {
            const retryAfterSec = Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000));
            res.set('Retry-After', String(retryAfterSec));
            res.status(429).json({ error: TOO_MANY_ATTEMPTS, retryAfterSec });
        },
    });

    router.post('/login', loginLimiter, async (req, res) => {
        const { value: creds, error } = loginBody(req.body);
        if (error) return res.status(400).json({ error });
        if (!USERNAME_PATTERN.test(creds.username)) {
            return res.status(401).json({ error: 'invalid username or password' });
        }

        let result;
        try {
            result = await verifier.verify({
                username: creds.username,
                password: creds.password,
                // limits of the service's VerifyCredentialsDto (longer values are a 400 there)
                clientIp: String(req.ip ?? '').slice(0, 64),
                userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
            });
        } catch (err) {
            log.error('login: zTraderService verify failed:', err.message);
            return res.status(502).json({ error: 'authentication service unavailable' });
        }

        if (!result.ok) {
            // 429 = the service is rate limiting. A locked account answers 401, like a bad password.
            if (result.status === 429) {
                res.set('Retry-After', String(result.retryAfterSec));
                return res.status(429).json({ error: TOO_MANY_ATTEMPTS, retryAfterSec: result.retryAfterSec });
            }
            log.info(`login failed for "${creds.username}" from ${req.ip}`);
            return res.status(401).json({ error: 'invalid username or password' });
        }

        if (result.user.mustChangePassword) {
            log.info(`login refused for "${creds.username}": password change required`);
            return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED', message: PASSWORD_CHANGE_MESSAGE });
        }

        // Never reuse a pre-login session (fixation).
        if (req.auth.session) sessions.revoke(req.auth.session);

        const { token, session } = sessions.create(publicUser(result.user), {
            ip: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.cookie(cookieName(req.auth.secure), token, cookieOptions(req.auth.secure));
        log.info(`login ok for "${session.user.username}" (${session.user.role}) from ${req.ip}`);
        res.json({ user: session.user, csrfToken: session.csrfToken });
    });

    router.get('/me', requireAuth, (req, res) => {
        res.json({ user: req.auth.user, csrfToken: req.auth.session.csrfToken });
    });

    router.post('/logout', requireAuth, csrfGuard, (req, res) => {
        sessions.revoke(req.auth.session);
        res.clearCookie(cookieName(req.auth.secure), cookieOptions(req.auth.secure));
        res.status(204).end();
    });

    return router;
}
