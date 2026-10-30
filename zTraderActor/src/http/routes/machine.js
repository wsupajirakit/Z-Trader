import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { log } from '../../logging/logger.js';
import { parseStartPayload } from '../../realtime/socket.js';
import { intParam } from '../validation.js';

export const DEFAULT_MACHINE_RATE_LIMIT = Object.freeze({ windowMs: 60 * 1000, limit: 600 });
export const MAX_LOG_PAGE = 500;
const DEFAULT_LOG_PAGE = 200;

/** Constant-time comparison that does not leak the length of either input. */
function keyMatches(given, expected) {
    if (typeof given !== 'string' || !expected) return false;
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b) && given.length === expected.length;
}

/**
 * The username zTraderService forwards for an action it proxies on behalf of a signed-in user.
 * Informational only (the API key authenticates), so it is reduced to a log-safe token.
 */
export function actorUserFrom(raw) {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== 'string') return null;
    const clean = v
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 64);
    return clean || null;
}

/**
 * /api/machine/* — server-to-server control of the strategy loop for zTraderService's dashboard.
 * Authenticated by the shared `x-api-key` only: browser sessions are not looked at, and these
 * routes are mounted before the browser origin/CSRF/session middleware.
 *
 * @param {{
 *   apiKey: string,
 *   engine: import('node:events').EventEmitter & {
 *     getSnapshot(): object, getState(): object, start(s: string[], m: string): void, stop(): void,
 *   },
 *   logBuffer: import('../../logging/LogBuffer.js').LogBuffer,
 *   rateLimit?: { windowMs: number, limit: number },
 * }} deps
 */
export function machineRoutes({ apiKey, engine, logBuffer, rateLimit: limits = DEFAULT_MACHINE_RATE_LIMIT }) {
    const router = Router();

    router.use(
        rateLimit({
            windowMs: limits.windowMs,
            limit: limits.limit,
            standardHeaders: 'draft-8',
            legacyHeaders: false,
            handler: (req, res) => res.status(429).json({ error: 'too many requests' }),
        }),
    );

    router.use((req, res, next) => {
        if (keyMatches(req.get('x-api-key'), apiKey)) return next();
        log.warn(`machine API ${req.method} ${req.path}: missing or invalid x-api-key from ${req.ip}`);
        res.status(401).json({ error: 'invalid or missing API key' });
    });

    const actingUser = (req) => actorUserFrom(req.headers['x-actor-user']) ?? 'dashboard';

    router.get('/engine', (req, res) => {
        res.json(engine.getSnapshot());
    });

    router.post('/engine/start', (req, res) => {
        const parsed = parseStartPayload(req.body);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const { symbols, mode } = parsed.value;
        log.info(`trading started by "${actingUser(req)}" (machine API): ${symbols.join(',')} ${mode}`);
        engine.start(symbols, mode);
        res.json({ ok: true, state: engine.getState() });
    });

    router.post('/engine/stop', (req, res) => {
        log.info(`trading stopped by "${actingUser(req)}" (machine API)`);
        engine.stop();
        res.json({ ok: true, state: engine.getState() });
    });

    router.get('/logs', (req, res) => {
        const after = intParam(req.query.after, { name: 'after', def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
        if (after.error) return res.status(400).json({ error: after.error });
        const limit = intParam(req.query.limit, { name: 'limit', def: DEFAULT_LOG_PAGE, min: 1, max: MAX_LOG_PAGE });
        if (limit.error) return res.status(400).json({ error: limit.error });
        res.json({ latestId: logBuffer.latestId, entries: logBuffer.since(after.value, limit.value) });
    });

    router.use((req, res) => res.status(404).json({ error: 'not found' }));
    return router;
}
