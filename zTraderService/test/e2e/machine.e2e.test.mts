/**
 * Machine API (x-api-key): zTraderActor and the /gold-run skill. Also proves the two auth schemes
 * never stand in for each other.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { getConnectionToken } from '@nestjs/mongoose';
import request from 'supertest';
import { io } from 'socket.io-client';
import { ADMIN, API_KEY, startApp, type TestApp } from './helpers/app.mts';

let t: TestApp;
before(async () => {
    t = await startApp();
});
after(async () => {
    await t.close();
});

const order = (uuid: string, extra: Record<string, unknown> = {}) => ({
    uuid,
    symbol: 'XAUUSD',
    volume: 0.01,
    orderType: 'MARKET',
    side: 'BUY',
    mode: 'Sonic',
    comment: 'zTraderActor',
    ...extra,
});

describe('API key routes', () => {
    it('refuse a missing or wrong key', async () => {
        await request(t.server).get('/gold/status').expect(401);
        await request(t.server).get('/gold/status').set('x-api-key', 'x'.repeat(48)).expect(401);
        await request(t.server).get('/history').expect(401);
        await request(t.server).get('/api/v1/klines/account').expect(401);
    });

    it('accept the right key', async () => {
        await request(t.server).get('/gold/status').set('x-api-key', API_KEY).expect(200);
        await request(t.server).get('/history').set('x-api-key', API_KEY).expect(200);
    });

    it('a browser session cannot call the machine API, and the key cannot call the dashboard API', async () => {
        const agent = request.agent(t.server);
        await agent.post('/api/auth/login').send(ADMIN).expect(200);
        await agent.get('/gold/status').expect(401);
        await request(t.server).get('/api/dashboard/status').set('x-api-key', API_KEY).expect(401);
    });
});

describe('POST /api/v1/auth/verify (zTraderActor login)', () => {
    it('returns the user for good credentials', async () => {
        const res = await request(t.server)
            .post('/api/v1/auth/verify')
            .set('x-api-key', API_KEY)
            .send({ ...ADMIN, clientIp: '203.0.113.7', userAgent: 'test' })
            .expect(200);
        assert.equal(res.body.user.username, ADMIN.username);
        assert.ok(!('passwordHash' in res.body.user));
    });

    it('401 for a bad password, and 401 without the key', async () => {
        await request(t.server)
            .post('/api/v1/auth/verify')
            .set('x-api-key', API_KEY)
            .send({ username: ADMIN.username, password: 'nope-nope-nope' })
            .expect(401);
        await request(t.server).post('/api/v1/auth/verify').send(ADMIN).expect(401);
    });
});

describe('GET /api/v1/auth/users/:id (Actor re-check)', () => {
    it('returns the user, and 404 once disabled', async () => {
        const verify = await request(t.server)
            .post('/api/v1/auth/verify')
            .set('x-api-key', API_KEY)
            .send(ADMIN)
            .expect(200);
        const id = verify.body.user.id as string;
        const ok = await request(t.server).get(`/api/v1/auth/users/${id}`).set('x-api-key', API_KEY).expect(200);
        assert.equal(ok.body.user.role, 'admin');
        await request(t.server).get(`/api/v1/auth/users/${id}`).expect(401);
        await request(t.server)
            .get('/api/v1/auth/users/000000000000000000000000')
            .set('x-api-key', API_KEY)
            .expect(404);
        await request(t.server).get('/api/v1/auth/users/not-an-id').set('x-api-key', API_KEY).expect(400);
    });
});

describe('POST /orders', () => {
    const key = { 'x-api-key': API_KEY };

    it('validates the body strictly', async () => {
        await request(t.server).post('/orders').set(key).send({ uuid: 'abc' }).expect(400);
        await request(t.server)
            .post('/orders')
            .set(key)
            .send(order('order-bad-0001', { volume: -1 }))
            .expect(400);
        await request(t.server)
            .post('/orders')
            .set(key)
            .send(order('order-bad-0002', { side: 'HOLD' }))
            .expect(400);
        await request(t.server)
            .post('/orders')
            .set(key)
            .send(order('order-bad-0003', { ctidTraderAccountId: 1 }))
            .expect(400);
    });

    it('refuses an accountId other than the one the service trades on', async () => {
        await request(t.server)
            .post('/orders')
            .set(key)
            .send(order('order-acct-0001', { accountId: 12345678 }))
            .expect(400);
    });

    it('treats accountId: null like an absent accountId', async () => {
        await request(t.server)
            .post('/orders')
            .set(key)
            .send(order('order-null-acct-0001', { accountId: null }))
            .expect(202);
    });

    it('refuses a caller-supplied unitsPerLot (the lot size comes from the symbol)', async () => {
        await request(t.server)
            .post('/orders')
            .set(key)
            .send(order('order-units-0001', { unitsPerLot: 1e9 }))
            .expect(400);
    });

    it('the unique index on orders.uuid exists after boot', async () => {
        const conn = t.app.get(getConnectionToken());
        const indexes = (await conn.collection('orders').indexes()) as Array<{ key: object; unique?: boolean }>;
        assert.ok(
            indexes.some((i) => i.unique === true && Object.keys(i.key).join(',') === 'uuid'),
            JSON.stringify(indexes),
        );
    });

    it('accepts once per uuid, even when two requests race', async () => {
        const [a, b] = await Promise.all([
            request(t.server).post('/orders').set(key).send(order('order-race-0001')),
            request(t.server).post('/orders').set(key).send(order('order-race-0001')),
        ]);
        assert.deepEqual([a.status, b.status].sort(), [202, 409]);
        await request(t.server).post('/orders').set(key).send(order('order-race-0001')).expect(409);
    });
});

describe('GET /history', () => {
    const key = { 'x-api-key': API_KEY };

    it('clamps page instead of failing', async () => {
        for (const page of ['-1', '0', 'abc', '1.5', '999999999']) {
            const res = await request(t.server).get(`/history?page=${page}`).set(key);
            assert.equal(res.status, 200, `page=${page}`);
            assert.ok(Array.isArray(res.body));
        }
    });

    it('a repeated query parameter is a 400, not a 500', async () => {
        await request(t.server).get('/history?mode=a&mode=b').set(key).expect(400);
        await request(t.server).get('/history/stat?mode=a&mode=b').set(key).expect(400);
        await request(t.server).get('/gold/archive?mode=swing&mode=scalp').set(key).expect(400);
    });
});

describe('machine /gold/* bodies (zTraderActor shapes)', () => {
    const key = { 'x-api-key': API_KEY };

    it('still accepts what zTraderActor sends', async () => {
        await request(t.server).post('/gold/run').set(key).send({ mode: 'swing', force: false }).expect(201);
        await request(t.server)
            .post('/gold/automate')
            .set(key)
            .send({ enabled: false, modes: ['swing'], instruments: ['XAUUSD'] })
            .expect(201);
        await request(t.server).post('/gold/automate').set(key).send({ enabled: false }).expect(201);
        await request(t.server).post('/gold/instrument').set(key).send({ symbol: 'xauusd' }).expect(201);
        await request(t.server).post('/gold/settings').set(key).send({ risk_usd_per_trade: 30 }).expect(201);
        await request(t.server)
            .post('/gold/claude/analyze')
            .set(key)
            .send({ mode: 'scalp', symbol: 'XAUUSD' })
            .expect(201);
        const rej = await request(t.server).post('/gold/claude/reject').set(key).send({ id: 'nope0001' }).expect(201);
        assert.deepEqual(rej.body, { rejected: false });
    });

    it('rejects values the dashboard would reject too', async () => {
        await request(t.server).post('/gold/run').set(key).send({ mode: 'yolo' }).expect(400);
        await request(t.server)
            .post('/gold/automate')
            .set(key)
            .send({ modes: ['swing'] })
            .expect(400);
        await request(t.server).post('/gold/instrument').set(key).send({ symbol: 'DOGE' }).expect(400);
        await request(t.server).post('/gold/instrument').set(key).send({}).expect(400);
        await request(t.server).post('/gold/claude/confirm').set(key).send({ mode: 'swing' }).expect(400);
        await request(t.server).post('/gold/settings').set(key).send([1]).expect(400);
    });

    it('a domain error keeps its message, and settings stay all-or-nothing', async () => {
        const res = await request(t.server)
            .post('/gold/claude/confirm')
            .set(key)
            .send({ mode: 'swing', id: 'nope0001' })
            .expect(400);
        assert.match(res.body.message, /no pending decision/);
        await request(t.server).post('/gold/settings').set(key).send({ ai_gate: 'always', max_lot: 1000 }).expect(400);
        const s = (await request(t.server).get('/gold/settings').set(key).expect(200)).body;
        assert.equal(s.ai_gate, 'near_miss');
    });

    it('a missing archive file is a 404 that does not reveal the path', async () => {
        const res = await request(t.server).get('/gold/archive/swing/20200101_000000_swing.json').set(key).expect(404);
        assert.ok(!JSON.stringify(res.body).includes(process.env.GOLD_ARCHIVE_DIR!));
        await request(t.server).get('/gold/archive/swing/not-a-file.txt').set(key).expect(400);
    });
});

describe('machine writes are audited', () => {
    const key = { 'x-api-key': API_KEY };
    const audit = async () =>
        (await t.get<any>('audit/audit.service.js#AuditService').list(200)).items as Array<Record<string, any>>;

    before(async () => {
        await t.resetData();
    });

    it('records actor null, via api-key and the sanitised X-Actor-User', async () => {
        await request(t.server)
            .post('/gold/settings')
            .set(key)
            .set('X-Actor-User', ' Alice<script>')
            .send({ risk_usd_per_trade: 25 })
            .expect(201);
        const ev = (await audit()).find((e) => e.action === 'settings.update');
        assert.ok(ev, 'settings.update audited');
        assert.equal(ev.actor, null);
        assert.equal(ev.success, true);
        assert.equal(ev.detail.via, 'api-key');
        assert.equal(ev.detail.actorUser, 'alicescript');
        assert.equal(ev.detail.risk_usd_per_trade, 25);
    });

    it('audits every machine write route, failures included', async () => {
        const writes: Array<[string, object, string]> = [
            ['/gold/run', { mode: 'swing' }, 'trade.run'],
            ['/gold/automate', { enabled: false }, 'automate.set'],
            ['/gold/instrument', { symbol: 'XAUUSD' }, 'instrument.set'],
            ['/gold/daily-stop/reset', {}, 'risk.daily_stop_reset'],
            ['/gold/ai/reset-calls', {}, 'ai.reset_calls'],
            ['/gold/claude/analyze', { mode: 'swing' }, 'trade.analyze'],
            ['/gold/claude/confirm', { mode: 'swing', id: 'nope0002' }, 'trade.confirm'],
            ['/gold/claude/reject', { mode: 'swing', id: 'nope0003' }, 'trade.reject'],
            ['/orders', order('order-audit-0001'), 'order.create'],
        ];
        for (const [path, body] of writes) {
            await request(t.server).post(path).set(key).set('X-Actor-User', 'bob').send(body);
        }
        const events = await audit();
        for (const [path, , action] of writes) {
            const ev = events.find((e) => e.action === action);
            assert.ok(ev, `${path} audited as ${action}`);
            assert.equal(ev.actor, null, action);
            assert.equal(ev.detail.via, 'api-key', action);
            assert.equal(ev.detail.actorUser, 'bob', action);
        }
        const confirm = events.find((e) => e.action === 'trade.confirm')!;
        assert.equal(confirm.success, false);
        assert.equal(confirm.target, 'nope0002');
        assert.match(String(confirm.detail.error), /no pending decision/);
        assert.equal(events.find((e) => e.action === 'order.create')!.target, 'order-audit-0001');
    });

    it('audits a validation failure, and omits actorUser when the header is absent', async () => {
        await request(t.server).post('/gold/run').set(key).send({ mode: 'yolo' }).expect(400);
        const ev = (await audit()).find((e) => e.action === 'trade.run' && e.success === false);
        assert.ok(ev);
        assert.ok(!('actorUser' in ev.detail));
        assert.match(String(ev.detail.error), /mode/);
    });

    it('reads and unauthenticated calls are not audited', async () => {
        const before = (await audit()).length;
        await request(t.server).get('/gold/status').set(key).expect(200);
        await request(t.server).post('/gold/settings').send({ risk_usd_per_trade: 25 }).expect(401);
        assert.equal((await audit()).length, before);
    });
});

describe('socket.io /klines', () => {
    let url: string;
    before(async () => {
        await t.app.listen(0, '127.0.0.1');
        url = `http://127.0.0.1:${(t.server.address() as AddressInfo).port}/klines`;
    });

    const tryConnect = (opts: Parameters<typeof io>[1]) =>
        new Promise<'connected' | 'refused'>((resolve) => {
            const s = io(url, { transports: ['websocket'], reconnection: false, timeout: 3000, ...opts });
            s.on('connect', () => {
                s.close();
                resolve('connected');
            });
            s.on('connect_error', () => {
                s.close();
                resolve('refused');
            });
        });

    it('refuses a handshake without the key', async () => {
        assert.equal(await tryConnect({}), 'refused');
        assert.equal(await tryConnect({ auth: { apiKey: 'wrong'.repeat(10) } }), 'refused');
    });

    it('accepts the key as a header (zTraderActor) or in auth', async () => {
        assert.equal(await tryConnect({ extraHeaders: { 'x-api-key': API_KEY } }), 'connected');
        assert.equal(await tryConnect({ auth: { apiKey: API_KEY } }), 'connected');
    });
});
