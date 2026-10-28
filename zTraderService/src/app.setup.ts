import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { applySecurity } from './common/http/security';
import { serveWebApp } from './common/http/web-app';

/**
 * Everything that makes an app instance production-shaped. main.ts and the e2e tests both call this,
 * so the tests exercise the same middleware, pipes and headers that are deployed.
 * The app must be created with `{ bodyParser: false }`.
 */
export function configureApp(app: NestExpressApplication) {
    const config = app.get(ConfigService);
    applySecurity(app, config.get<number>('TRUST_PROXY', 0));
    app.use(cookieParser());
    app.useBodyParser('json', { limit: '100kb' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    serveWebApp(app, config.get<string>('WEB_DIST_DIR', './web/dist'));
    // Coolify stops the container with SIGTERM — close the cTrader socket and Mongo cleanly
    app.enableShutdownHooks();
}
