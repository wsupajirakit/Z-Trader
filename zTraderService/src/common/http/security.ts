import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage, ServerResponse } from 'http';
import helmet from 'helmet';

/** API answers carry account data and must never be stored by a browser or a shared cache */
const NO_STORE_PREFIXES = ['/api/', '/gold', '/orders', '/history'];

/** placeholder the dashboard build writes into index.html (vite `html.cspNonce`); web-app.ts swaps in the real nonce */
export const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';

/** the per-request nonce set by applySecurity, readable from any later middleware */
export function cspNonce(res: Response | ServerResponse): string {
    return String((res as Response).locals?.cspNonce ?? '');
}

/**
 * HTTP hardening shared by the API and the dashboard bundle. The dashboard is a Vite build with no
 * inline script, so scripts stay origin-only. Styles are origin-only plus a fresh per-request nonce:
 * the UI kit (MUI/Emotion) injects <style> tags, and they carry that nonce.
 */
export function applySecurity(app: NestExpressApplication, trustProxyHops: number) {
    // only trust X-Forwarded-* written by our own proxies; 0 = use the socket peer
    app.set('trust proxy', trustProxyHops);
    app.disable('x-powered-by');
    app.use((req: Request, res: Response, next: NextFunction) => {
        res.locals.cspNonce = randomBytes(16).toString('base64');
        next();
    });
    app.use(
        helmet({
            contentSecurityPolicy: {
                useDefaults: false,
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", (_req: IncomingMessage, res: ServerResponse) => `'nonce-${cspNonce(res)}'`],
                    imgSrc: ["'self'", 'data:'],
                    fontSrc: ["'self'"],
                    connectSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    baseUri: ["'none'"],
                    formAction: ["'self'"],
                    frameAncestors: ["'none'"],
                    // no upgrade-insecure-requests: it breaks plain-http local runs, and HTTPS is the proxy's job
                },
            },
            crossOriginEmbedderPolicy: false,
            referrerPolicy: { policy: 'no-referrer' },
            strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
        }),
    );
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (NO_STORE_PREFIXES.some((p) => req.path.startsWith(p))) res.setHeader('Cache-Control', 'no-store');
        next();
    });
}
