import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, beforeEach, describe, test } from 'node:test';
import { tradeFeed } from '../src/logging/logger.js';
import { TradingEngine } from '../src/services/TradingEngine.js';
import { STRATEGY_MODES } from '../src/strategies/modes.js';
import { startHarness } from './helpers/harness.js';
import { STUB_API_KEY } from './helpers/stubService.js';

const KEY = { 'x-api-key': STUB_API_KEY };

describe('machine API (/api/machine)', () => {
    let h;
    before(async () => {
        h = await startHarness();
    });
    after(() => h.close());
    beforeEach(() => {
        h.engine.calls.length = 0;
        h.engine.state = { isRunning: false, symbols: ['XAUUSD'], mode: 'Sonic' };
    });

    test('every route requires the x-api-key', async () => {
        for (const [method, path] of [
            ['GET', '/api/machine/engine'],
            ['POST', '/api/machine/engine/start'],
            ['POST', '/api/machine/engine/stop'],
            ['GET', '/api/machine/logs'],
            ['GET', '/api/machine/nope'],
        ]) {
            const none = await h.request(path, { method, body: method === 'POST' ? {} : undefined });
            assert.equal(none.status, 401, `${method} ${path} without key`);
            assert.equal(typeof none.body.error, 'string');
            const wrong = await h.request(path, { method, headers: { 'x-api-key': `${STUB_API_KEY}x` } });
            assert.equal(wrong.status, 401, `${method} ${path} with wrong key`);
            const short = await h.request(path, { method, headers: { 'x-api-key': 'x' } });
            assert.equal(short.status, 401);
        }
        assert.equal(h.engine.calls.length, 0);
    });

    test('a browser session is not accepted in place of the key', async () => {
        const op = await h.login('olivia');
        const r = await h.request('/api/machine/engine/stop', { method: 'POST', cookie: op.cookie, csrf: op.csrf });
        assert.equal(r.status, 401);
        assert.equal((await h.request('/api/machine/engine', { cookie: op.cookie })).status, 401);
        assert.equal(h.engine.calls.length, 0);
    });

    test('GET /engine returns the snapshot', async () => {
        const r = await h.request('/api/machine/engine', { headers: KEY });
        assert.equal(r.status, 200);
        assert.equal(r.body.isRunning, false);
        assert.deepEqual(r.body.symbols, ['XAUUSD']);
        assert.equal(r.body.mode, 'Sonic');
        assert.equal(r.body.maxPositions, 1);
        assert.ok(r.body.modes.includes('Scalper'));
        assert.deepEqual(r.body.symbolsLive[0], {
            symbol: 'XAUUSD',
            price: null,
            rsi: null,
            ema: null,
            lastUpdate: null,
            hasReceived: false,
        });
        assert.equal(r.res.headers.get('cache-control'), 'no-store');
    });

    test('POST /engine/start validates with parseStartPayload and starts the engine', async () => {
        for (const body of [
            undefined,
            {},
            { symbols: [], mode: 'sonic' },
            { symbols: ['xauusd'], mode: 'sonic' },
            { symbols: ['XAUUSD'], mode: 'warp' },
            { symbols: Array(11).fill('XAUUSD'), mode: 'sonic' },
            ['XAUUSD'],
        ]) {
            const r = await h.request('/api/machine/engine/start', { method: 'POST', headers: KEY, body });
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.equal(typeof r.body.error, 'string');
        }
        assert.equal(h.engine.calls.length, 0);

        const ok = await h.request('/api/machine/engine/start', {
            method: 'POST',
            headers: { ...KEY, 'x-actor-user': 'olivia' },
            body: { symbols: ['EURUSD', 'EURUSD', 'XAUUSD'], mode: 'scalper' },
        });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.body, {
            ok: true,
            state: { isRunning: true, symbols: ['EURUSD', 'XAUUSD'], mode: 'Scalper' },
        });
        assert.deepEqual(h.engine.calls, [['start', ['EURUSD', 'XAUUSD'], 'Scalper']]);
    });

    test('POST /engine/stop stops the engine', async () => {
        h.engine.state = { isRunning: true, symbols: ['XAUUSD'], mode: 'Sonic' };
        const r = await h.request('/api/machine/engine/stop', { method: 'POST', headers: KEY });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { ok: true, state: { isRunning: false, symbols: ['XAUUSD'], mode: 'Sonic' } });
        assert.deepEqual(h.engine.calls, [['stop']]);
    });

    test('writes are exempt from the browser origin guard (no cookies are involved)', async () => {
        const r = await h.request('/api/machine/engine/stop', {
            method: 'POST',
            headers: KEY,
            origin: 'http://evil.example',
        });
        assert.equal(r.status, 200);
        // browser routes keep their protection
        const op = await h.login('olivia');
        const browser = await h.request('/api/gold/run', {
            method: 'POST',
            cookie: op.cookie,
            csrf: op.csrf,
            origin: 'http://evil.example',
            body: { mode: 'swing' },
        });
        assert.equal(browser.status, 403);
    });

    test('oversized and malformed bodies are rejected', async () => {
        const big = await h.request('/api/machine/engine/start', {
            method: 'POST',
            headers: KEY,
            body: JSON.stringify({ symbols: ['XAUUSD'], mode: 'sonic', pad: 'x'.repeat(40 * 1024) }),
        });
        assert.equal(big.status, 413);
        const bad = await h.request('/api/machine/engine/start', { method: 'POST', headers: KEY, body: '{nope' });
        assert.equal(bad.status, 400);
        assert.equal(h.engine.calls.length, 0);
    });

    test('GET /logs pages the trade feed forward, oldest first, with channels', async () => {
        const start = (await h.request('/api/machine/logs', { headers: KEY })).body.latestId;
        tradeFeed.emit('entry', { message: '[Think] thinking', type: 'info' });
        tradeFeed.emit('entry', { message: 'Trade executed successfully [BUY XAUUSD]', type: 'info' });
        tradeFeed.emit('entry', { message: 'Tick Error for XAUUSD: boom', type: 'error' });

        const all = await h.request(`/api/machine/logs?after=${start}`, { headers: KEY });
        assert.equal(all.status, 200);
        assert.equal(all.body.latestId, start + 3);
        assert.deepEqual(
            all.body.entries.map(({ id, type, message, channel }) => ({ id, type, message, channel })),
            [
                { id: start + 1, type: 'info', message: '[Think] thinking', channel: 'system' },
                {
                    id: start + 2,
                    type: 'info',
                    message: 'Trade executed successfully [BUY XAUUSD]',
                    channel: 'order',
                },
                { id: start + 3, type: 'error', message: 'Tick Error for XAUUSD: boom', channel: 'system' },
            ],
        );
        assert.equal(all.body.entries[0].ts, '2026-01-01T00:00:00.000Z');

        const page = await h.request(`/api/machine/logs?after=${start + 1}&limit=1`, { headers: KEY });
        assert.deepEqual(
            page.body.entries.map((e) => e.id),
            [start + 2],
        );
        const none = await h.request(`/api/machine/logs?after=${start + 3}`, { headers: KEY });
        assert.deepEqual(none.body, { latestId: start + 3, entries: [] });
    });

    test('GET /logs validates after and limit', async () => {
        for (const q of ['after=-1', 'after=abc', 'limit=0', 'limit=501', 'limit=1.5', 'after=1&after=2']) {
            const r = await h.request(`/api/machine/logs?${q}`, { headers: KEY });
            assert.equal(r.status, 400, q);
        }
        assert.equal((await h.request('/api/machine/logs?limit=500', { headers: KEY })).status, 200);
    });
});

describe('machine API rate limit', () => {
    let h;
    before(async () => {
        h = await startHarness({ machineRateLimit: { windowMs: 60_000, limit: 3 } });
    });
    after(() => h.close());

    test('answers 429 JSON once the budget is spent', async () => {
        for (let i = 0; i < 3; i++) {
            assert.equal((await h.request('/api/machine/engine', { headers: KEY })).status, 200);
        }
        const r = await h.request('/api/machine/engine', { headers: KEY });
        assert.equal(r.status, 429);
        assert.equal(r.body.error, 'too many requests');
    });
});

describe('TradingEngine.getSnapshot', () => {
    test('reports limits, modes and live values of the configured symbols only', () => {
        const engine = new TradingEngine({
            strategy: {},
            marketFeed: new EventEmitter(),
            trading: { symbols: ['XAUUSD', 'EURUSD'], mode: 'Sonic', maxPositions: 3 },
        });
        engine.onIndicators({ symbol: 'XAUUSD', price: 4000.5, rsi: 55.2, ema20: 3990.1 });
        engine.onIndicators({ symbol: 'GBPUSD', price: 1.3 }); // not configured: ignored
        const snap = engine.getSnapshot();
        assert.deepEqual(snap.symbols, ['XAUUSD', 'EURUSD']);
        assert.equal(snap.isRunning, false);
        assert.equal(snap.mode, 'Sonic');
        assert.equal(snap.maxPositions, 3);
        assert.deepEqual(snap.modes, [...STRATEGY_MODES]);
        assert.equal(snap.symbolsLive.length, 2);
        const [xau, eur] = snap.symbolsLive;
        assert.equal(xau.symbol, 'XAUUSD');
        assert.equal(xau.price, 4000.5);
        assert.equal(xau.rsi, 55.2);
        assert.equal(xau.ema, 3990.1);
        assert.equal(xau.hasReceived, true);
        assert.ok(!Number.isNaN(Date.parse(xau.lastUpdate)));
        assert.deepEqual(eur, {
            symbol: 'EURUSD',
            price: null,
            rsi: null,
            ema: null,
            lastUpdate: null,
            hasReceived: false,
        });
        // getState is unchanged
        assert.deepEqual(engine.getState(), { isRunning: false, symbols: ['XAUUSD', 'EURUSD'], mode: 'Sonic' });
    });
});
