import { createServer } from 'node:http';
import { CredentialVerifier } from './auth/CredentialVerifier.js';
import { SessionRevalidator } from './auth/SessionRevalidator.js';
import { SessionStore } from './auth/SessionStore.js';
import { createApp } from './http/app.js';
import { LogBuffer } from './logging/LogBuffer.js';
import { tradeFeed } from './logging/logger.js';
import { attachRealtime } from './realtime/socket.js';
import { ServiceClient } from './services/ServiceClient.js';

export const DEFAULT_LOGIN_RATE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, limit: 10 });

/**
 * Composition root for the HTTP + socket.io side. The trading engine is passed in, so
 * tests can supply a stub and never start the real strategy loop.
 *
 * @param {{
 *   config: ReturnType<typeof import('./config/env.js').loadConfig>,
 *   engine: import('node:events').EventEmitter & {
 *     getState(): object, getSnapshot(): object, start(s: string[], m: string): void, stop(): void,
 *   },
 *   api?: ServiceClient,
 *   now?: () => number,
 *   loginRateLimit?: { windowMs: number, limit: number },
 *   machineRateLimit?: { windowMs: number, limit: number },
 * }} opts
 */
export function createActor({
    config,
    engine,
    api = new ServiceClient({ baseUrl: config.service.url, apiKey: config.service.apiKey }),
    now = Date.now,
    loginRateLimit = DEFAULT_LOGIN_RATE_LIMIT,
    machineRateLimit,
}) {
    const sessions = new SessionStore({ now });
    const revalidator = new SessionRevalidator({ api, sessions, now });
    const verifier = new CredentialVerifier(api);

    const logBuffer = new LogBuffer({ now }).attach(tradeFeed);

    const app = createApp({
        config,
        api,
        sessions,
        revalidator,
        verifier,
        loginRateLimit,
        engine,
        logBuffer,
        machineRateLimit,
    });
    const httpServer = createServer(app);
    const realtime = attachRealtime({
        httpServer,
        sessions,
        revalidator,
        engine,
        tradeFeed,
        trustProxy: config.trustProxy,
    });

    return {
        app,
        httpServer,
        io: realtime.io,
        sessions,
        revalidator,
        api,
        logBuffer,
        /** @returns {Promise<import('node:net').AddressInfo>} */
        listen(port = config.port, host) {
            return new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(port, host, () => {
                    httpServer.off('error', reject);
                    resolve(httpServer.address());
                });
            });
        },
        async close() {
            revalidator.close();
            sessions.close();
            logBuffer.detach();
            await realtime.close(); // also closes the HTTP server
        },
    };
}
