import { Router } from 'express';
import { csrfGuard, requireAuth, requireRole } from '../../auth/middleware.js';
import { log } from '../../logging/logger.js';
import { archivePath, automateBody, flagParam, intParam, runBody, settingsBody } from '../validation.js';

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 120_000; // a forced /gold/run can include an AI round-trip

/**
 * /api/gold/* — the dashboard's view of zTraderService's gold bot.
 * The x-api-key is attached server-side; the browser never sees it. Every route needs a
 * session; writes need operator+ and a CSRF token. Paths and query strings sent upstream
 * are built here from validated values only.
 *
 * @param {{ api: import('../../services/ServiceClient.js').ServiceClient }} deps
 */
export function goldRoutes({ api }) {
    const router = Router();
    router.use(requireAuth, csrfGuard);

    async function proxy(res, method, path, { query, body, actor } = {}) {
        try {
            const upstream = await api.raw(method, path, {
                query,
                body,
                actor,
                timeoutMs: method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
            });
            // The service rejecting *our* API key is a server misconfiguration, not the user's
            // session problem; don't let the browser mistake it for "please log in again".
            if (upstream.status === 401 || upstream.status === 403) {
                await upstream.body?.cancel();
                log.error(`gold proxy ${method} ${path}: zTraderService answered ${upstream.status} (check API_KEY)`);
                return res.status(502).json({ error: 'Z Trader rejected the actor credentials' });
            }
            const text = await upstream.text();
            res.status(upstream.status).type('application/json').send(text);
        } catch (err) {
            log.error(`gold proxy ${method} ${path}: ${err.message}`);
            res.status(502).json({ error: 'Z Trader unreachable' });
        }
    }

    /** Validation helper: answer 400 or return the value. */
    const check = (res, result) => {
        if (result.error) {
            res.status(400).json({ error: result.error });
            return undefined;
        }
        return result;
    };

    router.get('/status', (req, res) => proxy(res, 'GET', '/gold/status'));
    router.get('/modes', (req, res) => proxy(res, 'GET', '/gold/modes'));
    router.get('/settings', (req, res) => proxy(res, 'GET', '/gold/settings'));
    router.get('/positions', (req, res) => proxy(res, 'GET', '/api/v1/klines/positions'));

    router.get('/archive', (req, res) => {
        const limit = check(res, intParam(req.query.limit, { name: 'limit', def: 10, min: 1, max: 200 }));
        if (limit) return proxy(res, 'GET', '/gold/archive', { query: { limit: limit.value } });
    });

    router.get('/archive/:mode/:file', (req, res) => {
        const p = check(res, archivePath(req.params));
        const full = p && check(res, flagParam(req.query.full, 'full'));
        if (!full) return;
        const path = `/gold/archive/${encodeURIComponent(p.value.mode)}/${encodeURIComponent(p.value.file)}`;
        return proxy(res, 'GET', path, { query: full.value ? { full: 1 } : undefined });
    });

    router.get('/activity', (req, res) => {
        const after = check(
            res,
            intParam(req.query.after, { name: 'after', def: 0, min: 0, max: Number.MAX_SAFE_INTEGER }),
        );
        if (after) return proxy(res, 'GET', '/gold/activity', { query: { after: after.value } });
    });

    router.get('/news', (req, res) => {
        const limit = check(res, intParam(req.query.limit, { name: 'limit', def: 20, min: 1, max: 50 }));
        if (limit) return proxy(res, 'GET', '/gold/news', { query: { limit: limit.value } });
    });

    const operator = requireRole('operator');

    router.post('/settings', operator, (req, res) => {
        const body = check(res, settingsBody(req.body));
        if (body) return proxy(res, 'POST', '/gold/settings', { body: body.value, actor: req.auth.user.username });
    });

    router.post('/run', operator, (req, res) => {
        const body = check(res, runBody(req.body));
        if (body) return proxy(res, 'POST', '/gold/run', { body: body.value, actor: req.auth.user.username });
    });

    router.post('/automate', operator, (req, res) => {
        const body = check(res, automateBody(req.body));
        if (body) return proxy(res, 'POST', '/gold/automate', { body: body.value, actor: req.auth.user.username });
    });

    router.use((req, res) => res.status(404).json({ error: 'not found' }));
    return router;
}
