import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createActor } from '../../src/actor.js';
import { loadConfig } from '../../src/config/env.js';
import { setLogLevel } from '../../src/logging/logger.js';
import { PASSWORD, startStubService, STUB_API_KEY } from './stubService.js';

setLogLevel('silent');

/** Stands in for TradingEngine so tests never start the real strategy loop. */
export class StubEngine extends EventEmitter {
    constructor() {
        super();
        this.calls = [];
        this.state = { isRunning: false, symbols: ['XAUUSD'], mode: 'Sonic' };
    }
    getState() {
        return { ...this.state };
    }
    getSnapshot() {
        return {
            ...this.getState(),
            maxPositions: 1,
            modes: ['Hardcode', 'Conservative', 'Swing', 'Merge', 'Sonic', 'Scalper'],
            symbolsLive: this.state.symbols.map((symbol) => ({
                symbol,
                price: null,
                rsi: null,
                ema: null,
                lastUpdate: null,
                hasReceived: false,
            })),
        };
    }
    start(symbols, mode) {
        this.calls.push(['start', symbols, mode]);
        this.state = { isRunning: true, symbols, mode };
        this.emit('state', this.getState());
    }
    stop() {
        this.calls.push(['stop']);
        this.state = { ...this.state, isRunning: false };
        this.emit('state', this.getState());
    }
}

/**
 * Starts the stub service and the actor (in-process, ephemeral ports) with a controllable clock.
 * @param {{
 *   env?: Record<string,string>,
 *   loginRateLimit?: { windowMs: number, limit: number },
 *   machineRateLimit?: { windowMs: number, limit: number },
 * }} [opts]
 */
export async function startHarness({
    env = {},
    loginRateLimit = { windowMs: 60_000, limit: 1000 },
    machineRateLimit,
} = {}) {
    const stub = await startStubService();
    const clock = {
        t: Date.parse('2026-01-01T00:00:00Z'),
        now: () => clock.t,
        advance: (ms) => {
            clock.t += ms;
        },
    };
    const config = loadConfig({ API_TRADER_URL: stub.url, API_KEY: STUB_API_KEY, ...env });
    const engine = new StubEngine();
    const actor = createActor({ config, engine, now: clock.now, loginRateLimit, machineRateLimit });
    const { port } = await actor.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;

    /** fetch wrapper: JSON in/out, optional cookie + CSRF, browser-like Origin on writes. */
    async function request(path, { method = 'GET', body, cookie, csrf, origin = base, headers = {} } = {}) {
        const h = { accept: 'application/json', ...headers };
        if (body !== undefined) h['content-type'] = 'application/json';
        if (cookie) h.cookie = cookie;
        if (csrf) h['x-csrf-token'] = csrf;
        if (origin && method !== 'GET') h.origin = origin;
        const res = await fetch(base + path, {
            method,
            headers: h,
            body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        });
        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        return { res, status: res.status, body: json, text };
    }

    /** GET with the path sent verbatim (fetch would normalise "%2e%2e" and "..") */
    function rawGet(path, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = httpRequest(base + '/', { method: 'GET', path, headers }, (res) => {
                res.resume();
                res.on('end', () => resolve({ status: res.statusCode }));
            });
            req.on('error', reject);
            req.end();
        });
    }

    /** Logs in and returns { cookie: "name=value", csrf, user, setCookie }. */
    async function login(username = 'olivia', password = PASSWORD, opts = {}) {
        const r = await request('/login', { method: 'POST', body: { username, password }, ...opts });
        if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${r.text}`);
        const setCookie = r.res.headers.get('set-cookie');
        return { cookie: setCookie.split(';')[0], csrf: r.body.csrfToken, user: r.body.user, setCookie };
    }

    return {
        base,
        stub,
        clock,
        engine,
        actor,
        config,
        request,
        rawGet,
        login,
        async close() {
            await actor.close();
            await stub.close();
        },
    };
}
