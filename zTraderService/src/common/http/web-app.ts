import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { CSP_NONCE_PLACEHOLDER, cspNonce } from './security';

/** Paths that belong to the API, so the single-page-app fallback must never answer them. */
const API_PREFIXES = ['/api/', '/gold', '/orders', '/history', '/health', '/socket.io'];

/**
 * Serves the built dashboard (web/dist). Hashed assets are cached for a year. index.html is never
 * cached, so a deploy is picked up on the next reload. Any other GET that is not an API path gets
 * index.html, so deep links into the client router work. index.html is templated per request: the
 * build leaves CSP_NONCE_PLACEHOLDER on its tags and meta, replaced here by this response's CSP nonce.
 */
export function serveWebApp(app: NestExpressApplication, distDir: string) {
    const root = resolve(distDir);
    const index = join(root, 'index.html');
    if (!existsSync(index)) {
        new Logger('WebApp').warn(`dashboard bundle not found at ${root} — run "npm run build:web" (API still works)`);
        return;
    }
    app.useStaticAssets(root, {
        index: false,
        setHeaders: (res, path) => {
            res.setHeader(
                'Cache-Control',
                path.includes(`${join(root, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
            );
        },
    });
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (API_PREFIXES.some((p) => req.path === p || req.path.startsWith(p.endsWith('/') ? p : `${p}/`)))
            return next();
        if (!req.accepts('html')) return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(readIndex(index).split(CSP_NONCE_PLACEHOLDER).join(cspNonce(res)));
    });
}

/** index.html, re-read only when the file changes (a rebuild while running must not serve stale asset names) */
let cached: { mtimeMs: number; html: string } | null = null;
function readIndex(path: string): string {
    const { mtimeMs } = statSync(path);
    if (!cached || cached.mtimeMs !== mtimeMs) cached = { mtimeMs, html: readFileSync(path, 'utf8') };
    return cached.html;
}
