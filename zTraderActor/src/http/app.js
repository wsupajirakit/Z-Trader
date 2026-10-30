import express from 'express';
import helmet from 'helmet';
import { STATUS_CODES } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadSession, originGuard } from '../auth/middleware.js';
import { log } from '../logging/logger.js';
import { authRoutes } from './routes/auth.js';
import { goldRoutes } from './routes/gold.js';
import { machineRoutes } from './routes/machine.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

/**
 * Builds the Express app. No side effects beyond the returned app.
 *
 * @param {{
 *   config: { trustProxy: number, service: { apiKey: string } },
 *   api: import('../services/ServiceClient.js').ServiceClient,
 *   sessions: import('../auth/SessionStore.js').SessionStore,
 *   revalidator: import('../auth/SessionRevalidator.js').SessionRevalidator,
 *   verifier: import('../auth/CredentialVerifier.js').CredentialVerifier,
 *   loginRateLimit: { windowMs: number, limit: number },
 *   engine: Parameters<typeof machineRoutes>[0]['engine'],
 *   logBuffer: import('../logging/LogBuffer.js').LogBuffer,
 *   machineRateLimit?: { windowMs: number, limit: number },
 * }} deps
 */
export function createApp({
    config,
    api,
    sessions,
    revalidator,
    verifier,
    loginRateLimit,
    engine,
    logBuffer,
    machineRateLimit,
}) {
    const app = express();
    // Number of reverse-proxy hops in front of us (Coolify/Traefik = 1). 0 = ignore X-Forwarded-*.
    app.set('trust proxy', config.trustProxy > 0 ? config.trustProxy : false);

    app.use(
        helmet({
            contentSecurityPolicy: {
                useDefaults: false,
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'"],
                    imgSrc: ["'self'", 'data:'],
                    fontSrc: ["'self'"],
                    connectSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    baseUri: ["'none'"],
                    formAction: ["'self'"],
                    frameAncestors: ["'none'"],
                },
            },
        }),
    );
    if (config.trustProxy === 0) app.use(warnOnForwardedHeaders());

    app.get('/health', (req, res) => res.json({ status: 'ok' }));

    app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore' }));

    // Everything below is dynamic and per-user.
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    app.use(express.json({ limit: '32kb' }));
    // Server-to-server (x-api-key only). Mounted before the browser origin guard and session loader:
    // these routes never look at cookies, so there is nothing for CSRF to protect.
    app.use(
        '/api/machine',
        machineRoutes({ apiKey: config.service.apiKey, engine, logBuffer, rateLimit: machineRateLimit }),
    );
    app.use(originGuard(config.trustProxy));
    app.use(loadSession(sessions, revalidator, config.trustProxy));

    app.use(authRoutes({ sessions, verifier, loginRateLimit }));
    app.use('/api/gold', goldRoutes({ api }));

    app.use((req, res) => res.status(404).json({ error: 'not found' }));

    // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
    app.use((err, req, res, next) => {
        if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request body too large' });
        if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
        if (status >= 500) log.error(`${req.method} ${req.path}: ${err.stack ?? err.message}`);
        res.status(status).json({ error: status < 500 && err.expose ? err.message : STATUS_CODES[status] });
    });

    return app;
}

/** Logs once when a proxy is evidently in front of us but TRUST_PROXY is 0. */
function warnOnForwardedHeaders() {
    let warned = false;
    return (req, res, next) => {
        if (!warned && req.headers['x-forwarded-proto']) {
            warned = true;
            log.warn(
                'X-Forwarded-Proto received but TRUST_PROXY=0: client IPs and HTTPS detection are wrong. ' +
                    'Set TRUST_PROXY=1 behind Coolify/Traefik.',
            );
        }
        next();
    };
}
