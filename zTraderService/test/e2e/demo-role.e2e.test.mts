/**
 * The demo role: it may open every screen and press every button, but nothing it does may open a
 * position, call an AI provider, notify the real chat or change shared state. Writes are simulated
 * (2xx, `simulated: true`), Run/Analyze run for real in a sandbox, and the broker / AI / order sinks
 * refuse anything that still reaches them inside a demo request.
 */
import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { ADMIN, startApp, type TestApp } from './helpers/app.mts';

const require = createRequire(import.meta.url);
const DIST = resolve(import.meta.dirname, '../../dist');
const { demoContext, DemoBlockedError } = require(join(DIST, 'common/demo/demo-context.js'));

let t: TestApp;
before(async () => {
    t = await startApp();
    await createDemoUser();
});
after(async () => {
    await t.close();
});

type Agent = ReturnType<typeof request.agent>;
async function login(username: string, password: string): Promise<{ agent: Agent; csrf: string }> {
    const agent = request.agent(t.server);
    const res = await agent.post('/api/auth/login').send({ username, password }).expect(200);
    return { agent, csrf: res.body.csrfToken as string };
}

const DEMO = { username: 'demo1', password: 'Demo-Pass-24680' };
async function demo(): Promise<{ agent: Agent; csrf: string }> {
    return login(DEMO.username, DEMO.password);
}

const automate = () => t.get<any>('gold/gold-automate.service.js#GoldAutomateService');
const auditActions = async () =>
    (await t.get<any>('audit/audit.service.js#AuditService').list(100)).items as Array<{
        action: string;
        target: string;
    }>;

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

async function createDemoUser() {
    // an admin creates the demo user; the demo user sets its own password (own-account writes are real)
    const admin = await login(ADMIN.username, ADMIN.password);
    await admin.agent
        .post('/api/users')
        .set('x-csrf-token', admin.csrf)
        .send({ username: DEMO.username, name: 'Demo', role: 'demo', password: 'Temp-Pass-13579' })
        .expect(201);
    const first = await login(DEMO.username, 'Temp-Pass-13579');
    await first.agent
        .post('/api/auth/change-password')
        .set('x-csrf-token', first.csrf)
        .send({ currentPassword: 'Temp-Pass-13579', newPassword: DEMO.password })
        .expect(204);
}

describe('demo role — reads', () => {
    it('can open every screen, admin ones included', async () => {
        const d = await demo();
        for (const path of [
            '/api/dashboard/status',
            '/api/dashboard/settings',
            '/api/risk-profiles',
            '/api/users',
            '/api/audit',
            '/api/actor/state',
        ]) {
            await d.agent.get(path).expect(200);
        }
    });

    it('the AI model list makes no provider request', async () => {
        const gemini = t.get<any>('gold/ai/gold-gemini.service.js#GoldGeminiService');
        let calls = 0;
        patch(globalThis, 'fetch', () => {
            calls++;
            return Promise.reject(new Error('no network in tests'));
        });
        patch(gemini, 'modelsCache', null);
        const d = await demo();
        await d.agent.get('/api/dashboard/ai/models').expect(200);
        assert.equal(calls, 0);
    });
});

describe('demo role — every write is simulated', () => {
    it('settings, loop, instrument, daily stop, AI quota, risk profiles, users, strategy: 2xx, nothing changes', async () => {
        const d = await demo();
        const before = (await d.agent.get('/api/dashboard/settings').expect(200)).body;
        const usersBefore = (await d.agent.get('/api/users').expect(200)).body.length;
        const writes: Array<[string, string, object]> = [
            ['post', '/api/dashboard/settings', { risk_usd_per_trade: 99_999, max_open_positions: 20 }],
            ['post', '/api/dashboard/automate', { enabled: true, modes: ['scalp'], instruments: ['XAUUSD'] }],
            ['post', '/api/dashboard/instrument', { symbol: 'EURUSD' }],
            ['post', '/api/dashboard/daily-stop/reset', {}],
            ['post', '/api/dashboard/ai/reset-calls', {}],
            ['post', '/api/risk-profiles/builtin:aggressive/apply', {}],
            ['post', '/api/risk-profiles', { name: 'Demo profile', values: {} }],
            ['delete', '/api/risk-profiles/builtin:balanced', {}],
            ['post', '/api/users', { username: 'sneaky', name: 'x', role: 'admin', password: 'Sneaky-Pass-1' }],
            ['patch', `/api/users/000000000000000000000000`, { role: 'admin' }],
            ['post', '/api/actor/start', { symbols: ['XAUUSD'], mode: 'Sonic' }],
            ['post', '/api/actor/stop', {}],
        ];
        for (const [method, path, body] of writes) {
            const res = await (d.agent as any)[method](path).set('x-csrf-token', d.csrf).send(body);
            assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status}`);
            assert.equal(res.body.simulated, true, `${method} ${path} must be simulated`);
        }
        const after = (await d.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(after.risk_usd_per_trade, before.risk_usd_per_trade);
        assert.equal(after.max_open_positions, before.max_open_positions);
        assert.equal(after.risk_profile ?? null, null);
        assert.deepEqual(after.overridden, before.overridden);
        assert.equal(existsSync(process.env.GOLD_SETTINGS_FILE!), false, 'nothing persisted');
        const status = (await d.agent.get('/api/dashboard/status').expect(200)).body;
        assert.equal(status.enabled, false, 'the loop was not started');
        assert.equal(status.instrument.key, 'XAUUSD', 'the instrument was not switched');
        assert.equal((await d.agent.get('/api/users').expect(200)).body.length, usersBefore);
        assert.equal(
            await t
                .collection('riskprofiles')
                .countDocuments({})
                .catch(() => 0),
            0,
        );
        const audit = await auditActions();
        assert.ok(audit.filter((e) => e.action === 'demo.simulated').length >= writes.length);
    });

    it('cannot fire a decision parked by the real bot', async () => {
        const a = automate();
        patch(a, 'ctraderService', {
            isAuthorized: true,
            getPositions: () => Promise.resolve({ position: [], order: [] }),
            cancelOrder: () => Promise.resolve(),
        });
        const decision = {
            order_type: 'BUY_LIMIT',
            entry: 4000,
            sl: 3990,
            tp1: 4020,
            tp2: null,
            rr_tp1: 2,
            confidence: 8,
            size: 'quarter',
            playbook_ref: 'swing #1',
            invalidation: '',
            valid_until_utc: null,
            reason: 'e2e',
            analysis_summary: '',
        };
        a.pending.set(a.sk('swing'), { id: 'real0001', decision, sizeCap: null, createdAt: Date.now() });
        restores.push(() => a.pending.clear());
        const d = await demo();
        const res = await d.agent
            .post('/api/dashboard/confirm')
            .set('x-csrf-token', d.csrf)
            .send({ mode: 'swing', id: 'real0001' });
        assert.equal(res.body.simulated, true);
        assert.ok(a.pending.get(a.sk('swing')), 'still parked for a real operator');
        assert.equal(await t.collection('orders').countDocuments({}), 0);
    });

    it('a CSRF-less write is still refused (simulation never weakens the guards)', async () => {
        const d = await demo();
        await d.agent.post('/api/dashboard/settings').send({ risk_usd_per_trade: 5 }).expect(403);
    });
});

describe('demo role — Run / Analyze run for real in a sandbox', () => {
    const BUY = {
        order_type: 'BUY_LIMIT',
        entry: 3990,
        sl: 3984,
        tp1: 4005,
        tp2: null,
        rr_tp1: 2.5,
        confidence: 8,
        size: 'full',
        valid_until_utc: null,
        invalidation: '',
        playbook_ref: 'swing #1',
        reason: 'ta setup',
        analysis_summary: '',
    };

    /** a connected broker and a TA setup that passes every guard, with spies on every sink */
    function armRound(aiMode: 'off' | 'assist' | 'lead' | 'ai_only') {
        const a = automate();
        const calls: string[] = [];
        const spy =
            (name: string) =>
            (..._args: unknown[]) => {
                calls.push(name);
                return Promise.reject(new Error(`${name} must not be called`));
            };
        patch(a, 'ctraderService', {
            isAuthorized: true,
            getPositions: () => Promise.resolve({ position: [], order: [] }),
            cancelOrder: spy('cancelOrder'),
            request: spy('ctrader.request'),
        });
        patch(a.instruments, 'resolveSymbolId', () => Promise.resolve(41));
        patch(a, 'getOpenPositions', () => Promise.resolve({ count: 0, summary: '' }));
        patch(a, 'getTodayPnl', () => Promise.resolve(0));
        patch(a, 'getData', () =>
            Promise.resolve({ series: { xauusd_1h: [] }, errors: null, files: new Map(), formula: '' }),
        );
        patch(a, 'checkDataIntegrity', () => null);
        patch(a.goldTaService, 'analyze', () => ({ ...BUY }));
        patch(a, 'aiMode', () => aiMode);
        patch(a, 'checkRiskBudget', () => null);
        patch(a, 'tradableModesFor', () => ['swing']);
        // a weekday in market hours, whatever day the suite runs (only Date is mocked, not timers)
        mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-28T14:00:00Z') });
        restores.push(() => mock.timers.reset());
        patch(a.goldGeminiService, 'assist', spy('gemini.assist'));
        patch(a.goldGeminiService, 'propose', spy('gemini.propose'));
        patch(a.goldGeminiService, 'tryConsume', (..._a: unknown[]) => {
            calls.push('quota');
            return true;
        });
        patch(a.executionService, 'executeOrder', spy('executeOrder'));
        patch(a.ordersService, 'createOrder', spy('createOrder'));
        patch(a.telegramService, 'notifyOrderSuccess', spy('telegram'));
        return { a, calls };
    }

    const archiveCount = () => {
        const dir = process.env.GOLD_ARCHIVE_DIR!;
        return existsSync(dir)
            ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json')).length
            : 0;
    };

    for (const aiMode of ['off', 'assist', 'lead', 'ai_only'] as const) {
        it(`run (AI ${aiMode}): simulated order, no AI call, no quota, no state, no archive`, async () => {
            const { a, calls } = armRound(aiMode);
            const archivedBefore = archiveCount();
            const stateBefore = JSON.stringify([...a.state.entries()]);
            const d = await demo();
            const res = await d.agent
                .post('/api/dashboard/run')
                .set('x-csrf-token', d.csrf)
                .send({ mode: 'swing', force: true })
                .expect(201);
            if (aiMode === 'ai_only') {
                assert.match(res.body.outcome, /^no-trade: AI found no setup: Simulated AI answer \(demo role/);
            } else {
                assert.match(res.body.outcome, /^order simulated \(demo — nothing was sent to the broker\)/);
            }
            assert.deepEqual(calls, [], `sinks reached: ${calls.join(', ')}`);
            assert.equal(archiveCount(), archivedBefore);
            assert.equal(JSON.stringify([...a.state.entries()]), stateBefore, 'the real mode state is untouched');
            assert.equal(await t.collection('orders').countDocuments({}), 0);
            if (aiMode === 'assist')
                assert.match(res.body.decision.reason, /AI ยืนยัน|AI confirmed|Simulated AI answer|ta setup/);
        });
    }

    it('analyze: the decision is shown but never parked (no one could fire it)', async () => {
        const { a, calls } = armRound('off');
        const d = await demo();
        const res = await d.agent
            .post('/api/dashboard/analyze')
            .set('x-csrf-token', d.csrf)
            .send({ mode: 'swing', force: true })
            .expect(201);
        assert.match(res.body.outcome, /^awaiting-approval \(demo — not stored, cannot be fired\)/);
        assert.equal(a.pending.size, 0);
        assert.deepEqual(calls, []);
    });

    it('activity lines from a demo round are labelled', async () => {
        armRound('off');
        const d = await demo();
        await d.agent
            .post('/api/dashboard/run')
            .set('x-csrf-token', d.csrf)
            .send({ mode: 'swing', force: true })
            .expect(201);
        const act = (await d.agent.get('/api/dashboard/activity?after=0').expect(200)).body.entries as Array<{
            message: string;
        }>;
        assert.ok(act.some((e) => e.message.startsWith('[DEMO demo1] order simulated')));
    });
});

describe('demo role — sinks refuse anything that slips through', () => {
    it('broker trading commands, orders, AI clients and shared-state writes throw inside a demo context', async () => {
        const ctrader = t.get<any>('ctrader/ctrader.service.js#CtraderService');
        const execution = t.get<any>('execution/execution.service.js#ExecutionService');
        const orders = t.get<any>('orders/orders.service.js#OrdersService');
        const gemini = t.get<any>('gold/ai/gold-gemini.service.js#GoldGeminiService');
        const claude = t.get<any>('gold/ai/gold-ai.service.js#GoldAiService');
        const a = automate();
        await demoContext.run('demo1', async () => {
            for (const type of [
                'ProtoOANewOrderReq',
                'ProtoOAAmendPositionSLTPReq',
                'ProtoOACancelOrderReq',
                'ProtoOAClosePositionReq',
                'SomethingNew',
            ]) {
                assert.throws(() => ctrader.send(type, {}), DemoBlockedError, type);
            }
            assert.throws(
                () => ctrader.send('ProtoOATraderReq', {}),
                (e: Error) => !(e instanceof DemoBlockedError),
                'reads pass the demo gate',
            );
            // the e2e harness stubs executeOrder on the instance; test the real method
            await assert.rejects(
                Object.getPrototypeOf(execution).executeOrder.call(execution, { uuid: 'x' }),
                DemoBlockedError,
            );
            await assert.rejects(orders.createOrder({ uuid: 'x' }), DemoBlockedError);
            assert.throws(() => gemini.getClient(), DemoBlockedError);
            assert.throws(() => claude.getClient(), DemoBlockedError);
            assert.throws(() => a.setSettings({ risk_usd_per_trade: 5 }), DemoBlockedError);
            assert.throws(() => a.setAutomate(true), DemoBlockedError);
            assert.throws(() => a.setInstrument('EURUSD'), DemoBlockedError);
            assert.throws(() => a.resetDailyStop(), DemoBlockedError);
            assert.throws(() => a.resetAiCalls(), DemoBlockedError);
            await assert.rejects(a.confirmPending('swing', 'x'), DemoBlockedError);
        });
        assert.equal(demoContext.active, false);
    });

    it('a real operator is not affected', async () => {
        const op = await login(ADMIN.username, ADMIN.password);
        await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_gate: 'always' })
            .expect(201);
        assert.equal((await op.agent.get('/api/dashboard/settings').expect(200)).body.ai_gate, 'always');
        automate().overrides.clear();
    });
});
