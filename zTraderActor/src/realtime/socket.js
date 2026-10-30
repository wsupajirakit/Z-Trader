import { Server } from 'socket.io';
import { isSecureRequest, readSessionToken } from '../auth/cookies.js';
import { isSameOrigin, requestHost } from '../auth/middleware.js';
import { authorize } from '../auth/roles.js';
import { channelOf } from '../logging/channels.js';
import { log } from '../logging/logger.js';
import { isValidSymbol, MAX_SYMBOLS, normalizeMode } from '../strategies/modes.js';

/** Every socket that passed the handshake joins this room; nothing is sent to the whole server. */
export const AUTH_ROOM = 'authenticated';
const sessionRoom = (session) => `session:${session.id}`;

/** @returns {{ value: { symbols: string[], mode: string } } | { error: string }} */
export function parseStartPayload(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { error: 'payload must be an object' };
    const { symbols } = data;
    if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > MAX_SYMBOLS) {
        return { error: `symbols must be a list of 1-${MAX_SYMBOLS} symbols` };
    }
    if (!symbols.every(isValidSymbol)) return { error: 'invalid symbol' };
    const mode = normalizeMode(data.mode);
    if (!mode) return { error: 'unknown mode' };
    return { value: { symbols: [...new Set(symbols)], mode } };
}

/**
 * Attaches socket.io to the HTTP server.
 *
 * - The handshake must carry a valid session cookie and a same-origin Origin header.
 * - `startTrading` / `stopTrading` need operator+, and the session is re-checked on every event.
 * - Logs, market ticks and state go to AUTH_ROOM only.
 *
 * @param {{
 *   httpServer: import('node:http').Server,
 *   sessions: import('../auth/SessionStore.js').SessionStore,
 *   revalidator: import('../auth/SessionRevalidator.js').SessionRevalidator,
 *   engine: import('node:events').EventEmitter & { getState(): object, start(s: string[], m: string): void, stop(): void },
 *   tradeFeed: import('node:events').EventEmitter,
 *   trustProxy: number,
 * }} deps
 */
export function attachRealtime({ httpServer, sessions, revalidator, engine, tradeFeed, trustProxy }) {
    const io = new Server(httpServer, {
        maxHttpBufferSize: 16 * 1024,
        // Same-origin only. WebSockets are not covered by CORS, so check Origin ourselves.
        allowRequest: (req, callback) => callback(null, isSameOrigin(req.headers, requestHost(req, trustProxy))),
    });

    io.use(async (socket, next) => {
        const req = socket.request;
        const session = sessions.get(readSessionToken(req, isSecureRequest(req, trustProxy)));
        if (session) await revalidator.refresh(session);
        if (!session || !sessions.isActive(session, { touch: false })) return next(new Error('unauthorized'));
        socket.data.session = session;
        next();
    });

    io.on('connection', (socket) => {
        const { session } = socket.data;
        socket.join([AUTH_ROOM, sessionRoom(session)]);
        socket.emit('stateUpdate', engine.getState());

        /** Wraps an event handler with session re-validation, authorisation and ack handling. */
        const on = (event, minimumRole, handler) => {
            socket.on(event, async (...args) => {
                const ack = typeof args.at(-1) === 'function' ? args.pop() : undefined;
                const reply = (result) => {
                    if (ack) ack(result);
                    else if (!result.ok) socket.emit('actionError', { event, error: result.error });
                };
                // An expired/revoked session ends -> its sockets are disconnected via the `end` event.
                if (!sessions.isActive(session)) return socket.disconnect(true);
                await revalidator.refresh(session); // may revoke, demote or mark unverified
                if (!sessions.isActive(session, { touch: false })) return socket.disconnect(true);
                const allowed = authorize(session, minimumRole);
                if (!allowed.ok) {
                    log.warn(
                        `socket ${event} denied for "${session.user.username}" (${session.user.role}): ${allowed.status}`,
                    );
                    return reply({ ok: false, error: allowed.error });
                }
                try {
                    reply(handler(...args) ?? { ok: true });
                } catch (err) {
                    log.error(`socket ${event}: ${err.message}`);
                    reply({ ok: false, error: 'internal error' });
                }
            });
        };

        on('startTrading', 'operator', (data) => {
            const parsed = parseStartPayload(data);
            if (parsed.error) return { ok: false, error: parsed.error };
            log.info(
                `trading started by "${session.user.username}": ${parsed.value.symbols.join(',')} ${parsed.value.mode}`,
            );
            engine.start(parsed.value.symbols, parsed.value.mode);
        });

        on('stopTrading', 'operator', () => {
            log.info(`trading stopped by "${session.user.username}"`);
            engine.stop();
        });
    });

    const room = () => io.to(AUTH_ROOM);
    const onState = (state) => room().emit('stateUpdate', state);
    const onMarket = (update) => room().emit('marketUpdate', update);
    const onEntry = ({ message, type }) => {
        // order-ish lines go to the orders pane (see logging/channels.js)
        if (channelOf(message) === 'order') room().emit('orderLog', { message, type: 'success' });
        else room().emit('log', { message, type });
    };
    const onSessionEnd = (session) => io.in(sessionRoom(session)).disconnectSockets(true);

    engine.on('state', onState);
    engine.on('market', onMarket);
    tradeFeed.on('entry', onEntry);
    sessions.on('end', onSessionEnd);

    return {
        io,
        close() {
            engine.off('state', onState);
            engine.off('market', onMarket);
            tradeFeed.off('entry', onEntry);
            sessions.off('end', onSessionEnd);
            return io.close();
        },
    };
}
