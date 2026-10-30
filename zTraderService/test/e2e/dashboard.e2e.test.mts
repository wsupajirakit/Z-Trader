/**
 * Dashboard API (/api/dashboard, session + CSRF): settings are all-or-nothing, errors map to the right
 * status without leaking internals, the archive never reveals a path, and a parked decision is
 * executed at most once. No broker: the few broker calls a confirm makes are stubbed per test.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import request from 'supertest';
import { ADMIN, startApp, type TestApp } from './helpers/app.mts';

let t: TestApp;
before(async () => {
    t = await startApp();
});
after(async () => {
    await t.close();
});

type Agent = ReturnType<typeof request.agent>;
async function operator(): Promise<{ agent: Agent; csrf: string }> {
    const agent = request.agent(t.server);
    const res = await agent.post('/api/auth/login').send(ADMIN).expect(200);
    return { agent, csrf: res.body.csrfToken as string };
}

const automate = () => t.get<any>('gold/gold-automate.service.js#GoldAutomateService');
const auditList = async () =>
    (await t.get<any>('audit/audit.service.js#AuditService').list(50)).items as Array<Record<string, any>>;

/** monkey-patches restored after each test, so one test's stub never leaks into the next */
const restores: Array<() => void> = [];
function patch<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const old = obj[key];
    obj[key] = value;
    restores.push(() => {
        if (had) obj[key] = old;
        else delete obj[key];
    });
}
afterEach(() => {
    while (restores.length) restores.pop()!();
});

describe('POST /api/dashboard/settings', () => {
    before(async () => {
        await t.resetData();
    });

    it('one invalid field rejects the whole body: nothing applied, nothing persisted', async () => {
        const op = await operator();
        const res = await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_gate: 'always', max_lot: 1000 })
            .expect(400);
        assert.match(res.body.message, /max_lot/);
        const s = (await op.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(s.ai_gate, 'near_miss');
        assert.deepEqual(s.overridden, []);
        assert.equal(existsSync(process.env.GOLD_SETTINGS_FILE!), false, 'settings file must not be written');
    });

    it('a valid body is applied and persisted', async () => {
        const op = await operator();
        await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_gate: 'always', max_lot: 2 })
            .expect(201);
        const s = (await op.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(s.ai_gate, 'always');
        assert.ok(existsSync(process.env.GOLD_SETTINGS_FILE!));
        // leave the shared service as the other suites expect it
        automate().overrides.clear();
    });

    it('rejects a non-object body', async () => {
        const op = await operator();
        await op.agent.post('/api/dashboard/settings').set('x-csrf-token', op.csrf).send([1, 2]).expect(400);
    });
});

describe('action error mapping', () => {
    before(async () => {
        await t.resetData();
    });

    it('a domain error is a 400 with its message', async () => {
        const op = await operator();
        const res = await op.agent
            .post('/api/dashboard/confirm')
            .set('x-csrf-token', op.csrf)
            .send({ mode: 'swing', id: 'nope0001' })
            .expect(400);
        assert.match(res.body.message, /no pending decision/);
    });

    it('an HttpException thrown by the action keeps its status', async () => {
        patch(automate(), 'resetDailyStop', () => {
            throw new ConflictException('busy');
        });
        const op = await operator();
        const res = await op.agent.post('/api/dashboard/daily-stop/reset').set('x-csrf-token', op.csrf).expect(409);
        assert.equal(res.body.message, 'busy');
    });

    it('an unexpected error is a generic 500, still audited with the real message', async () => {
        patch(automate(), 'resetAiCalls', () => {
            throw new TypeError('cannot read x of undefined at /srv/secret/path.js');
        });
        const op = await operator();
        const res = await op.agent.post('/api/dashboard/ai/reset-calls').set('x-csrf-token', op.csrf).expect(500);
        assert.ok(!JSON.stringify(res.body).includes('/srv/secret'), JSON.stringify(res.body));
        assert.ok(!JSON.stringify(res.body).includes('TypeError'));
        const ev = (await auditList()).find((e) => e.action === 'ai.reset_calls');
        assert.ok(ev, 'audited');
        assert.equal(ev.success, false);
        assert.match(String(ev.detail?.error), /cannot read x/);
    });

    it('GET history without a broker is a 400 (domain), not a 500', async () => {
        const op = await operator();
        const res = await op.agent.get('/api/dashboard/history?days=7').expect(400);
        assert.match(res.body.message, /not authorized/);
    });
});

describe('confirm a parked decision', () => {
    before(async () => {
        await t.resetData();
    });

    const DECISION = {
        order_type: 'BUY_LIMIT',
        entry: 4001.5,
        sl: 3995,
        tp1: 4015,
        tp2: null,
        rr_tp1: 2,
        confidence: 7,
        size: 'quarter',
        playbook_ref: 'swing #1',
        invalidation: '',
        valid_until_utc: null,
        reason: 'e2e',
        analysis_summary: 'e2e',
    };

    /** a broker that is "connected" with no open positions, and a parked swing decision */
    function parkDecision(id: string, trace?: unknown) {
        const a = automate();
        patch(a, 'ctraderService', {
            isAuthorized: true,
            getPositions: () => Promise.resolve({ position: [], order: [] }),
            cancelOrder: () => Promise.resolve(),
        });
        a.pending.set(a.sk('swing'), { id, decision: DECISION, sizeCap: null, createdAt: Date.now(), trace });
        restores.push(() => a.pending.clear());
    }
    const orderCount = (uuidPrefix: string): Promise<number> =>
        t.app
            .get(getConnectionToken())
            .collection('orders')
            .countDocuments({ uuid: { $regex: `^${uuidPrefix}` } });

    it('two concurrent confirms place exactly one order', async () => {
        parkDecision('race0001');
        const op = await operator();
        const send = () =>
            op.agent
                .post('/api/dashboard/confirm')
                .set('x-csrf-token', op.csrf)
                .send({ mode: 'swing', id: 'race0001' });
        const [a, b] = await Promise.all([send(), send()]);
        assert.deepEqual([a.status, b.status].sort(), [201, 400]);
        assert.equal(await orderCount('gold-swing-'), 1);
    });

    it('order placed but the notification failed: success with a warning', async () => {
        await t.resetData();
        parkDecision('warn0001');
        patch(automate(), 'telegramService', {
            notifyOrderSuccess: () => Promise.reject(new Error('telegram down')),
            notifyError: () => Promise.resolve(),
        });
        const op = await operator();
        const res = await op.agent
            .post('/api/dashboard/confirm')
            .set('x-csrf-token', op.csrf)
            .send({ mode: 'swing', id: 'warn0001' })
            .expect(201);
        assert.match(res.body.uuid, /^gold-swing-/);
        assert.match(res.body.warning, /notification failed/);
        assert.equal(await orderCount('gold-swing-'), 1);
        const ev = (await auditList()).find((e) => e.action === 'trade.confirm');
        assert.equal(ev?.success, true);
    });
});

describe('order context (backtest record)', () => {
    before(async () => {
        await t.resetData();
    });

    it('a fired order stores the configuration, guards and sizing it was placed under', async () => {
        const a = automate();
        patch(a, 'ctraderService', {
            isAuthorized: true,
            getPositions: () => Promise.resolve({ position: [], order: [] }),
            cancelOrder: () => Promise.resolve(),
        });
        const { newTrace } = createRequire(import.meta.url)(
            join(import.meta.dirname, '../../dist/gold/records/round-context.js'),
        );
        const trace = newTrace(a.configSnapshot(a.profile, 'swing', 1.8));
        trace.guards.daily_pnl_usd = -12.5;
        a.pending.set(a.sk('swing'), {
            id: 'ctx00001',
            decision: { ...CONTEXT_DECISION },
            sizeCap: null,
            createdAt: Date.now(),
            trace,
        });
        restores.push(() => a.pending.clear());
        const op = await operator();
        const res = await op.agent
            .post('/api/dashboard/confirm')
            .set('x-csrf-token', op.csrf)
            .send({ mode: 'swing', id: 'ctx00001' })
            .expect(201);
        const order = await t.collection('orders').findOne({ uuid: res.body.uuid });
        assert.equal(order?.configHash, trace.config_hash);
        assert.equal(order?.riskProfile, 'custom');
        assert.equal(order?.context.config.mode.name, 'swing');
        assert.equal(order?.context.guards.daily_pnl_usd, -12.5);
        assert.equal(order?.context.sizing.method, 'risk');
        assert.equal(order?.context.sizing.lots, order?.volume);
        assert.doesNotMatch(JSON.stringify(order?.context), /API_KEY|ACCESS_TOKEN|APP_SECRET/);
    });
});

const CONTEXT_DECISION = {
    order_type: 'BUY_LIMIT',
    entry: 4001.5,
    sl: 3995,
    tp1: 4015,
    tp2: null,
    rr_tp1: 2,
    confidence: 7,
    size: 'quarter',
    playbook_ref: 'swing #1',
    invalidation: '',
    valid_until_utc: null,
    reason: 'e2e',
    analysis_summary: 'e2e',
};

describe('archive', () => {
    before(async () => {
        await t.resetData();
        const dir = join(process.env.GOLD_ARCHIVE_DIR!, 'swing');
        mkdirSync(dir, { recursive: true });
        for (const s of ['20260801_090000', '20260802_090000', '20260803_090000']) {
            writeFileSync(
                join(dir, `${s}_swing.json`),
                JSON.stringify({ outcome: `out ${s}`, series_tail: { x: [] } }),
            );
        }
    });

    it('lists newest first and honours the limit', async () => {
        const op = await operator();
        const res = await op.agent.get('/api/dashboard/archive?mode=swing&limit=2').expect(200);
        assert.deepEqual(
            res.body.map((r: { file: string }) => r.file),
            ['swing/20260803_090000_swing.json', 'swing/20260802_090000_swing.json'],
        );
        assert.equal(res.body[0].outcome, 'out 20260803_090000');
    });

    it('reads a file, and a missing one is a 404 that does not reveal the path', async () => {
        const op = await operator();
        const ok = await op.agent.get('/api/dashboard/archive/swing/20260801_090000_swing.json').expect(200);
        assert.equal(ok.body.outcome, 'out 20260801_090000');
        assert.ok(!('series_tail' in ok.body));
        const res = await op.agent.get('/api/dashboard/archive/swing/20200101_000000_swing.json').expect(404);
        const text = JSON.stringify(res.body);
        assert.ok(!text.includes(process.env.GOLD_ARCHIVE_DIR!), text);
        assert.ok(!/ENOENT|\/swing\//.test(text), text);
    });

    it('rejects a file name the service could not have written', async () => {
        const op = await operator();
        await op.agent.get('/api/dashboard/archive/swing/..%2F..%2Fetc%2Fpasswd').expect(400);
        await op.agent.get('/api/dashboard/archive/bogus/20260801_090000_swing.json').expect(400);
    });
});

describe('shared DTO validation', () => {
    before(async () => {
        await t.resetData();
    });

    it('rejects unknown modes, instruments and fields', async () => {
        const op = await operator();
        const post = (path: string, body: object) =>
            op.agent.post(`/api/dashboard/${path}`).set('x-csrf-token', op.csrf).send(body);
        await post('run', { mode: 'yolo' }).expect(400);
        await post('run', { mode: 'swing', extra: 1 }).expect(400);
        await post('automate', { enabled: false, modes: ['swing', 'bogus'] }).expect(400);
        await post('automate', { enabled: false, instruments: ['DOGE'] }).expect(400);
        await post('instrument', { symbol: 'DOGE' }).expect(400);
    });
});
