import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

/** API answers carry account data and must never be stored by a browser or a shared cache */
const NO_STORE_PREFIXES = ['/api/', '/gold', '/orders', '/history'];

/**
 * HTTP hardening shared by the API and the dashboard bundle. The dashboard is a Vite build with no
 * inline script, so the CSP can stay strict: scripts and styles from our own origin only.
 */
export function applySecurity(app: NestExpressApplication, trustProxyHops: number) {
    // only trust X-Forwarded-* written by our own proxies; 0 = use the socket peer
    app.set('trust proxy', trustProxyHops);
    app.disable('x-powered-by');
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
