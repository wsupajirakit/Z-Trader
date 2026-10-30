import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, afterEach, before, describe, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { tradeFeed } from '../src/logging/logger.js';
import { startHarness } from './helpers/harness.js';

describe('socket.io', () => {
    let h;
    const open = [];

    /** Connects a client; resolves once connected or rejects with the connect_error. */
    function client({ cookie, origin } = {}) {
        const extraHeaders = {};
        if (cookie) extraHeaders.cookie = cookie;
        if (origin) extraHeaders.origin = origin;
        const socket = connect(h.base, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            extraHeaders,
        });
        open.push(socket);
        return new Promise((resolve, reject) => {
            socket.once('connect', () => resolve(socket));
            socket.once('connect_error', reject);
        });
    }

    before(async () => {
        h = await startHarness();
    });
    afterEach(() => open.splice(0).forEach((s) => s.disconnect()));
    after(() => h.close());

    test('unauthenticated sockets are rejected', async () => {
        await assert.rejects(client(), /unauthorized/);
        await assert.rejects(client({ cookie: 'zta_session=forged' }), /unauthorized/);
    });

    test('cross-origin handshakes are rejected even with a valid cookie', async () => {
        const { cookie } = await h.login();
        await assert.rejects(client({ cookie, origin: 'http://evil.example' }));
    });

    test('authenticated socket gets state on connect and log lines from the trade feed', async () => {
        const { cookie } = await h.login('victor');
        const socket = connect(h.base, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            extraHeaders: { cookie, origin: h.base },
        });
        open.push(socket);
        const [state] = await once(socket, 'stateUpdate');
        assert.deepEqual(state, { isRunning: false, symbols: ['XAUUSD'], mode: 'Sonic' });

        const logged = once(socket, 'log');
        const ordered = once(socket, 'orderLog');
        tradeFeed.emit('entry', { message: '[Think] thinking', type: 'info' });
        tradeFeed.emit('entry', { message: 'Trade executed successfully [BUY XAUUSD]', type: 'info' });
        assert.deepEqual((await logged)[0], { message: '[Think] thinking', type: 'info' });
        assert.equal((await ordered)[0].type, 'success');
    });

    test('viewer cannot startTrading or stopTrading', async () => {
        const { cookie } = await h.login('victor');
        const socket = await client({ cookie });
        const res = await socket.emitWithAck('startTrading', { symbols: ['XAUUSD'], mode: 'sonic' });
        assert.equal(res.ok, false);
        assert.match(res.error, /requires role operator/);
        const stop = await socket.emitWithAck('stopTrading');
        assert.equal(stop.ok, false);
        assert.equal(h.engine.calls.length, 0);
    });

    test('operator can start and stop; mode is normalised; state is broadcast', async () => {
        const { cookie } = await h.login('olivia');
        const socket = await client({ cookie });
        // the connect-time stateUpdate may still be in flight, so wait for the running one
        const update = new Promise((resolve) => {
            socket.on('stateUpdate', (st) => st.isRunning && resolve(st));
        });
        const res = await socket.emitWithAck('startTrading', { symbols: ['XAUUSD', 'EURUSD'], mode: 'sCALPER' });
        assert.deepEqual(res, { ok: true });
        assert.deepEqual(h.engine.calls.at(-1), ['start', ['XAUUSD', 'EURUSD'], 'Scalper']);
        assert.deepEqual(await update, { isRunning: true, symbols: ['XAUUSD', 'EURUSD'], mode: 'Scalper' });

        assert.deepEqual(await socket.emitWithAck('stopTrading'), { ok: true });
        assert.deepEqual(h.engine.calls.at(-1), ['stop']);
    });

    test('startTrading payloads are validated', async () => {
        const { cookie } = await h.login('olivia');
        const socket = await client({ cookie });
        h.engine.calls.length = 0;
        for (const payload of [
            undefined,
            'XAUUSD',
            { symbols: 'XAUUSD', mode: 'Sonic' },
            { symbols: [], mode: 'Sonic' },
            { symbols: ['../etc'], mode: 'Sonic' },
            { symbols: ['xauusd'], mode: 'Sonic' },
            { symbols: Array(11).fill('XAUUSD'), mode: 'Sonic' },
            { symbols: ['XAUUSD'], mode: 'YOLO' },
            { symbols: ['XAUUSD'], mode: { toString: 1 } },
        ]) {
            const res = await socket.emitWithAck('startTrading', payload);
            assert.equal(res.ok, false, JSON.stringify(payload));
        }
        assert.equal(h.engine.calls.length, 0);
    });

    test('logout disconnects that session’s sockets; expired sessions cannot act', async () => {
        const { cookie, csrf } = await h.login('olivia');
        const socket = await client({ cookie });
        const disconnected = once(socket, 'disconnect');
        await h.request('/logout', { method: 'POST', cookie, csrf });
        const [reason] = await disconnected;
        assert.equal(reason, 'io server disconnect');

        const other = await h.login('olivia');
        const s2 = await client({ cookie: other.cookie });
        h.engine.calls.length = 0;
        h.clock.advance(3 * 60 * 60 * 1000); // past the idle timeout
        const dropped = once(s2, 'disconnect');
        s2.emit('startTrading', { symbols: ['XAUUSD'], mode: 'Sonic' });
        assert.equal((await dropped)[0], 'io server disconnect');
        assert.equal(h.engine.calls.length, 0);
    });
});
