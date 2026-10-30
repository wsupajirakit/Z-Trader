/**
 * Backend pieces of the terminal UI: the per-request CSP style nonce templated into index.html,
 * the account summary, risk profiles (built-in + saved, apply through the validated settings path,
 * "modified" tracking, audit) and the AI decision settings (mode, model, strictness veto).
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { ADMIN, startApp, type TestApp } from './helpers/app.mts';

const require = createRequire(import.meta.url);
const DIST = resolve(import.meta.dirname, '../../dist');
const webDir = mkdtempSync(join(tmpdir(), 'zt-web-'));
mkdirSync(join(webDir, 'assets'));
writeFileSync(
    join(webDir, 'index.html'),
    '<!doctype html><html><head><meta property="csp-nonce" nonce="__CSP_NONCE__"><script type="module" nonce="__CSP_NONCE__" src="/assets/app.js"></script></head><body></body></html>',
);

let t: TestApp;
before(async () => {
    t = await startApp({ WEB_DIST_DIR: webDir });
});
after(async () => {
    await t.close();
    rmSync(webDir, { recursive: true, force: true });
});

type Agent = ReturnType<typeof request.agent>;
async function admin(): Promise<{ agent: Agent; csrf: string }> {
    const agent = request.agent(t.server);
    const res = await agent.post('/api/auth/login').send(ADMIN).expect(200);
    return { agent, csrf: res.body.csrfToken as string };
}

const automate = () => t.get<any>('gold/gold-automate.service.js#GoldAutomateService');
const account = () => t.get<any>('account/account.service.js#AccountService');
const auditList = async () =>
    (await t.get<any>('audit/audit.service.js#AuditService').list(50)).items as Array<Record<string, any>>;

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
    automate().overrides.clear();
});

describe('CSP style nonce', () => {
    it('index.html carries this response nonce, matching the CSP header, fresh per request', async () => {
        const nonceOf = async () => {
            const res = await request(t.server).get('/').set('Accept', 'text/html').expect(200);
            const csp = String(res.headers['content-security-policy']);
            const fromHeader = /style-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
            const fromHtml = /property="csp-nonce" nonce="([^"]+)"/.exec(res.text)?.[1];
            assert.ok(fromHeader, `style-src must carry a nonce: ${csp}`);
            assert.equal(fromHtml, fromHeader);
            assert.ok(!res.text.includes('__CSP_NONCE__'), 'placeholder must be replaced everywhere');
            assert.match(csp, /script-src 'self'(;|$)/, 'scripts stay origin-only');
            return fromHeader;
        };
        const a = await nonceOf();
        const b = await nonceOf();
        assert.notEqual(a, b);
    });
});

describe('GET /api/dashboard/account', () => {
    it('needs a session', async () => {
        await request(t.server).get('/api/dashboard/account').expect(401);
    });
    it('reports unavailable while cTrader is not connected', async () => {
        const { agent } = await admin();
        const res = await agent.get('/api/dashboard/account').expect(200);
        assert.equal(res.body.available, false);
        assert.equal(res.body.balance, null);
        assert.match(res.body.error, /not authorized/);
    });
});

describe('risk profiles', () => {
    before(async () => {
        await t.resetData();
    });

    it('lists the 4 built-ins; % profiles cannot resolve without a balance', async () => {
        const { agent } = await admin();
        const res = await agent.get('/api/risk-profiles').expect(200);
        const names = res.body.profiles.filter((p: any) => p.builtIn).map((p: any) => p.name);
        assert.deepEqual(names, ['Conservative', 'Balanced', 'Aggressive', 'Micro account']);
        const byName = Object.fromEntries(res.body.profiles.map((p: any) => [p.name, p]));
        assert.equal(byName['Balanced'].resolved, null);
        assert.equal(byName['Micro account'].resolved.risk_usd_per_trade, 10);
        assert.equal(res.body.active, null);
    });

    it('apply goes through the validated settings path, persists the marker and audits', async () => {
        const op = await admin();
        const res = await op.agent
            .post('/api/risk-profiles/builtin:micro/apply')
            .set('x-csrf-token', op.csrf)
            .expect(201);
        assert.equal(res.body.applied.daily_max_loss_usd, 30);
        const s = (await op.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(s.risk_usd_per_trade, 10);
        assert.equal(s.max_open_positions, 1);
        assert.equal(s.max_lot_by_instrument.XAUUSD, 0.01);
        assert.deepEqual(s.risk_profile, { id: 'builtin:micro', name: 'Micro account', modified: false, changed: [] });
        assert.ok(automate().overrides.has('GOLD_RISK_PROFILE'));
        const audit = await auditList();
        assert.ok(audit.some((e) => e.action === 'risk_profile.apply' && e.target === 'builtin:micro' && e.success));

        // a hand edit afterwards marks the profile as modified
        await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ risk_usd_per_trade: 20 })
            .expect(201);
        const s2 = (await op.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(s2.risk_profile.modified, true);
        assert.deepEqual(s2.risk_profile.changed, ['risk_usd_per_trade']);
    });

    it('a % profile needs the balance; with it the USD values follow the balance', async () => {
        const op = await admin();
        const refused = await op.agent
            .post('/api/risk-profiles/builtin:conservative/apply')
            .set('x-csrf-token', op.csrf)
            .expect(400);
        assert.match(refused.body.message, /balance is not available/);

        patch(account(), 'summary', () => Promise.resolve({ available: true, balance: 10_000, currency: 'USD' }));
        await op.agent.post('/api/risk-profiles/builtin:conservative/apply').set('x-csrf-token', op.csrf).expect(201);
        const s = (await op.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(s.risk_usd_per_trade, 50);
        assert.equal(s.daily_max_loss_usd, 200);
        assert.equal(s.min_confidence, 8);
    });

    it('saved profiles: create, duplicate names refused, bad values refused, update, apply, delete', async () => {
        const op = await admin();
        const values = {
            risk_per_trade: { unit: 'usd', value: 25 },
            daily_max_loss: { unit: 'usd', value: 100 },
            max_open_positions: 2,
            max_open_positions_total: 4,
            min_confidence: 7,
            loss_cooldown_bars: 2,
            scalp_max_per_day: 6,
            max_lot: { EURUSD: 0.5 },
        };
        const created = await op.agent
            .post('/api/risk-profiles')
            .set('x-csrf-token', op.csrf)
            .send({ name: 'Night desk', description: 'quiet hours', values })
            .expect(201);
        assert.equal(created.body.builtIn, false);
        assert.equal(created.body.resolved.max_lot_eurusd, 0.5);

        await op.agent
            .post('/api/risk-profiles')
            .set('x-csrf-token', op.csrf)
            .send({ name: 'Night desk', values })
            .expect(409);
        await op.agent
            .post('/api/risk-profiles')
            .set('x-csrf-token', op.csrf)
            .send({ name: 'balanced', values })
            .expect(409);
        const bad = await op.agent
            .post('/api/risk-profiles')
            .set('x-csrf-token', op.csrf)
            .send({ name: 'Bad', values: { ...values, min_confidence: 9 } })
            .expect(400);
        assert.match(bad.body.message, /min_confidence/);
        await op.agent.post('/api/risk-profiles').send({ name: 'No csrf', values }).expect(403);

        const id = created.body.id as string;
        await op.agent
            .patch(`/api/risk-profiles/${id}`)
            .set('x-csrf-token', op.csrf)
            .send({ values: { ...values, risk_per_trade: { unit: 'usd', value: 30 } } })
            .expect(200);
        await op.agent.post(`/api/risk-profiles/${id}/apply`).set('x-csrf-token', op.csrf).expect(201);
        const s = (await op.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(s.risk_usd_per_trade, 30);
        assert.equal(s.risk_profile.name, 'Night desk');

        await op.agent.delete('/api/risk-profiles/builtin:balanced').set('x-csrf-token', op.csrf).expect(400);
        await op.agent.delete(`/api/risk-profiles/${id}`).set('x-csrf-token', op.csrf).expect(200);
        await op.agent.post(`/api/risk-profiles/${id}/apply`).set('x-csrf-token', op.csrf).expect(404);
    });
});

describe('round context (backtest record)', () => {
    it('every round archives the configuration it ran under, without credentials', async () => {
        const op = await admin();
        await op.agent.post('/api/risk-profiles/builtin:micro/apply').set('x-csrf-token', op.csrf).expect(201);
        await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_strictness: 'strict' })
            .expect(201);
        // no broker here: the round stops at the first guard, but it is still archived with its context
        await op.agent.post('/api/dashboard/analyze').set('x-csrf-token', op.csrf).send({ mode: 'swing' }).expect(201);
        const list = (await op.agent.get('/api/dashboard/archive?limit=1').expect(200)).body as Array<{ file: string }>;
        const [mode, file] = list[0].file.split('/');
        const round = (await op.agent.get(`/api/dashboard/archive/${mode}/${file}`).expect(200)).body;
        const ctx = round.context;
        assert.equal(ctx.schema, 1);
        assert.match(ctx.config_hash, /^[0-9a-f]{12}$/);
        assert.equal(ctx.config.risk_profile.name, 'Micro account');
        assert.equal(ctx.config.risk.risk_usd_per_trade, 10);
        assert.equal(ctx.config.ai.strictness, 'strict');
        assert.equal(ctx.config.mode.name, 'swing');
        assert.equal(ctx.config.account_mode, 'DEMO');
        assert.ok(ctx.config.overrides.GOLD_RISK_PROFILE);
        assert.doesNotMatch(JSON.stringify(round), /API_KEY|ACCESS_TOKEN|APP_SECRET|test-api-key/);
    });
});

describe('AI decision settings', () => {
    it('modes and models are refused when the provider key is missing', async () => {
        const op = await admin();
        const noGemini = await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_mode: 'ai_only' })
            .expect(400);
        assert.match(noGemini.body.message, /GEMINI_API_KEY/);
        const noClaude = await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_model: 'claude-opus-5-5' })
            .expect(400);
        assert.match(noClaude.body.message, /ANTHROPIC_API_KEY/);
        await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_mode: 'turbo' })
            .expect(400);
    });

    it('strictness is stored and reported, unknown levels refused', async () => {
        const op = await admin();
        await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_strictness: 'very_strict' })
            .expect(201);
        const s = (await op.agent.get('/api/dashboard/settings').expect(200)).body;
        assert.equal(s.ai_strictness, 'very_strict');
        assert.equal(s.ai_strictness_min_confidence, 7);
        assert.equal(s.engine, 'ta');
        await op.agent
            .post('/api/dashboard/settings')
            .set('x-csrf-token', op.csrf)
            .send({ ai_strictness: 'lax' })
            .expect(400);
    });

    it('strictness vetoes an AI confirmation below its threshold; normal keeps the old behaviour', () => {
        const { INSTRUMENTS } = require(join(DIST, 'gold/domain/instruments.js'));
        const svc = automate();
        const ta = {
            order_type: 'BUY_LIMIT',
            entry: 4000,
            sl: 3990,
            tp1: 4020,
            tp2: null,
            rr_tp1: 2,
            confidence: 7,
            size: 'full',
            valid_until_utc: null,
            invalidation: '',
            playbook_ref: 'P1',
            reason: 'ta setup',
            analysis_summary: '',
        };
        const ai = {
            verdict: 'CONFIRM',
            entry: null,
            sl: null,
            tp1: null,
            tp2: null,
            size: 'full',
            confidence: 5,
            key_levels: '',
            reason: 'ok',
            risk_note: '',
        };
        const normal = svc.applyAssist(ta, ai, 1.5, INSTRUMENTS.XAUUSD);
        assert.equal(normal.order_type, 'BUY_LIMIT');
        assert.equal(normal.confidence, 5, 'AI may still lower the confidence');
        svc.overrides.set('GOLD_AI_STRICTNESS', 'strict');
        const strict = svc.applyAssist(ta, ai, 1.5, INSTRUMENTS.XAUUSD);
        assert.equal(strict.order_type, 'NO_TRADE');
        assert.match(strict.reason, /below the strict strictness threshold 6/);
    });

    it('the model list reports keys and providers', async () => {
        const { agent } = await admin();
        const res = await agent.get('/api/dashboard/ai/models').expect(200);
        assert.equal(res.body.has_gemini_key, false);
        assert.equal(res.body.has_claude_key, false);
        assert.deepEqual(res.body.models, []);
    });
});
