import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, afterEach, before, describe, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { RECHECK_INTERVAL_MS } from '../src/auth/SessionRevalidator.js';
import { UNVERIFIED_MESSAGE } from '../src/auth/roles.js';
import { startHarness } from './helpers/harness.js';

const START = { symbols: ['XAUUSD'], mode: 'Sonic' };

describe('session re-check against zTraderService (GET /api/v1/auth/users/:id)', () => {
    let h;
    const sockets = [];

    function socketFor(cookie) {
        const s = connect(h.base, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            extraHeaders: { cookie },
        });
        sockets.push(s);
        return new Promise((resolve, reject) => {
            s.once('connect', () => resolve(s));
            s.once('connect_error', reject);
        });
    }

    const userChecks = () => h.stub.calls('/api/v1/auth/users/');
    const run = (who) =>
        h.request('/api/gold/run', { method: 'POST', cookie: who.cookie, csrf: who.csrf, body: { mode: 'swing' } });
    const sessionOf = (who) => h.actor.sessions.list().find((s) => s.csrfToken === who.csrf);

    before(async () => {
        h = await startHarness();
    });
    afterEach(() => {
        sockets.splice(0).forEach((s) => s.disconnect());
        for (const id of ['u-op', 'u-view', 'u-admin']) h.stub.setUser(id, null);
        h.stub.setUsersEndpointDown(false);
        h.stub.reset();
    });
    after(() => h.close());

    test('at most one re-check per 60 s per session, single-flight under concurrency', async () => {
        const op = await h.login('olivia');
        h.stub.reset();
        await h.request('/me', { cookie: op.cookie });
        await h.request('/me', { cookie: op.cookie });
        assert.equal(userChecks().length, 0, 'fresh login needs no re-check');

        h.clock.advance(RECHECK_INTERVAL_MS);
        await Promise.all(Array.from({ length: 5 }, () => h.request('/me', { cookie: op.cookie })));
        assert.equal(userChecks().length, 1);
        assert.equal(userChecks()[0].path, '/api/v1/auth/users/u-op');

        await h.request('/me', { cookie: op.cookie });
        assert.equal(userChecks().length, 1, 'not re-checked again within 60 s');
    });

    for (const [label, override] of [
        ['user disabled (404)', { disabled: true }],
        ['user unknown (404)', { status: 404 }],
        ['password reset (mustChangePassword)', { mustChangePassword: true }],
    ]) {
        test(`${label} revokes the session and disconnects its sockets`, async () => {
            const op = await h.login('olivia');
            const socket = await socketFor(op.cookie);
            const dropped = once(socket, 'disconnect');

            h.stub.setUser('u-op', override);
            h.clock.advance(RECHECK_INTERVAL_MS);
            assert.equal((await h.request('/me', { cookie: op.cookie })).status, 401);
            assert.equal((await dropped)[0], 'io server disconnect');
            assert.equal(sessionOf(op), undefined);
        });
    }

    test('passwordChangedAt after the login revokes; before the login does not', async () => {
        const op = await h.login('olivia');
        const created = sessionOf(op).createdAt;

        h.stub.setUser('u-op', { passwordChangedAt: new Date(created - 60_000).toISOString() });
        h.clock.advance(RECHECK_INTERVAL_MS);
        assert.equal((await h.request('/me', { cookie: op.cookie })).status, 200, 'older change keeps the session');

        h.stub.setUser('u-op', { passwordChangedAt: new Date(created + 1000).toISOString() });
        h.clock.advance(RECHECK_INTERVAL_MS);
        assert.equal((await h.request('/me', { cookie: op.cookie })).status, 401);
    });

    test('a demotion takes effect within 60 s, over HTTP and socket.io', async () => {
        const op = await h.login('olivia');
        const socket = await socketFor(op.cookie);
        assert.equal((await run(op)).status, 201);

        h.stub.setUser('u-op', { role: 'viewer' });
        assert.equal((await run(op)).status, 201, 'still operator until the next re-check is due');

        h.clock.advance(RECHECK_INTERVAL_MS);
        assert.equal((await run(op)).status, 403);
        assert.equal((await h.request('/me', { cookie: op.cookie })).body.user.role, 'viewer');
        const res = await socket.emitWithAck('startTrading', START);
        assert.equal(res.ok, false);
        assert.match(res.error, /requires role operator/);
        assert.ok(socket.connected, 'a demoted user keeps read access');
    });

    test('a promotion is picked up too (socket event triggers the re-check)', async () => {
        const viewer = await h.login('victor');
        const socket = await socketFor(viewer.cookie);
        h.stub.setUser('u-view', { role: 'operator' });
        h.clock.advance(RECHECK_INTERVAL_MS);
        h.engine.calls.length = 0;
        assert.deepEqual(await socket.emitWithAck('startTrading', START), { ok: true });
        assert.equal(h.engine.calls.length, 1);
    });

    for (const [label, breakIt] of [
        ['unreachable', () => h.stub.setUsersEndpointDown(true)],
        ['answering 503', () => h.stub.setUser('u-op', { status: 503 })],
    ]) {
        test(`service ${label}: reads keep working, operator actions are refused until a good re-check`, async () => {
            const op = await h.login('olivia');
            const socket = await socketFor(op.cookie);
            breakIt();
            h.clock.advance(RECHECK_INTERVAL_MS);

            assert.equal((await h.request('/me', { cookie: op.cookie })).status, 200, 'session kept');
            assert.equal((await h.request('/api/gold/status', { cookie: op.cookie })).status, 200, 'reads allowed');
            const write = await run(op);
            assert.equal(write.status, 503);
            assert.equal(write.body.error, UNVERIFIED_MESSAGE);
            assert.equal(h.stub.calls('/gold/run').length, 0);
            const res = await socket.emitWithAck('startTrading', START);
            assert.deepEqual(res, { ok: false, error: UNVERIFIED_MESSAGE });

            h.stub.setUsersEndpointDown(false);
            h.stub.setUser('u-op', null);
            assert.equal((await run(op)).status, 503, 'no extra re-check before 60 s');
            h.clock.advance(RECHECK_INTERVAL_MS);
            assert.equal((await run(op)).status, 201, 'a successful re-check restores writes');
        });
    }

    test('the sweep re-checks idle sessions without any request', async () => {
        const op = await h.login('olivia');
        const viewer = await h.login('victor');
        h.stub.setUser('u-op', { disabled: true });
        h.clock.advance(RECHECK_INTERVAL_MS);
        await h.actor.revalidator.sweep();
        assert.equal(sessionOf(op), undefined, 'disabled user revoked');
        assert.ok(sessionOf(viewer), 'other sessions untouched');
    });
});
