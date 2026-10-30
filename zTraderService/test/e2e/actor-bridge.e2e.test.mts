/**
 * Dashboard -> zTraderActor bridge (/api/actor/*, session + CSRF). A tiny HTTP server plays the Actor's
 * machine API (/api/machine/*, x-api-key) so the proxying, role checks, audit and failure modes are
 * tested without the real strategy loop. ACTOR_URL unset is covered in actor-bridge-unset.e2e.test.mts
 * (ConfigModule reads the environment once per process).
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ADMIN, API_KEY, startApp, type TestApp } from './helpers/app.mts';

interface Seen {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: unknown;
}

/** Stand-in for zTraderActor's /api/machine routes, with switches for the failure modes. */
class StubActor {
    server!: Server;
    url = '';
    seen: Seen[] = [];
    mode: 'ok' | 'down' | 'wrong-key' = 'ok';
    engine = { isRunning: false, symbols: ['XAUUSD'], mode: 'Sonic' };
    logs = [
        { id: 1, ts: '2026-10-30T00:00:00.000Z', type: 'info', message: '[คิด] thinking', channel: 'system' },
        { id: 2, ts: '2026-10-30T00:00:01.000Z', type: 'info', message: 'Trade executed', channel: 'order' },
    ];

    async start() {
        this.server = createServer((req, res) => void this.handle(req, res));
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    stop() {
        return new Promise<void>((resolve) => {
            this.server.closeAllConnections();
            this.server.close(() => resolve());
        });
    }

    private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body: unknown = raw ? JSON.parse(raw) : undefined;
        this.seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const send = (status: number, payload: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        };
        if (this.mode === 'down') return req.socket.destroy();
        const key = this.mode === 'wrong-key' ? 'something-else' : API_KEY;
        if (req.headers['x-api-key'] !== key) return send(401, { error: 'invalid or missing API key' });

        const url = new URL(req.url!, 'http://stub');
        const route = `${req.method} ${url.pathname}`;
        if (route === 'GET /api/machine/engine') {
            return send(200, {
                ...this.engine,
                maxPositions: 1,
                modes: ['Hardcode', 'Conservative', 'Swing', 'Merge', 'Sonic', 'Scalper'],
                symbolsLive: this.engine.symbols.map((symbol) => ({
                    symbol,
                    price: 4001.5,
                    rsi: 51.2,
                    ema: 3999.9,
                    lastUpdate: '2026-10-30T00:00:00.000Z',
                    hasReceived: true,
                })),
            });
        }
        if (route === 'GET /api/machine/logs') {
            const afterId = Number(url.searchParams.get('after') ?? 0);
            const limit = Number(url.searchParams.get('limit') ?? 200);
            return send(200, {
                latestId: this.logs.at(-1)!.id,
                entries: this.logs.filter((e) => e.id > afterId).slice(0, limit),
            });
        }
        if (route === 'POST /api/machine/engine/start') {
            const b = body as { symbols?: string[]; mode?: string };
            if (b?.mode !== 'sonic' && b?.mode !== 'scalper') return send(400, { error: 'unknown mode' });
            this.engine = { isRunning: true, symbols: b.symbols!, mode: b.mode === 'sonic' ? 'Sonic' : 'Scalper' };
            return send(200, { ok: true, state: this.engine });
        }
        if (route === 'POST /api/machine/engine/stop') {
            this.engine = { ...this.engine, isRunning: false };
            return send(200, { ok: true, state: this.engine });
        }
        send(404, { error: 'not found' });
    }
}

type Agent = ReturnType<typeof request.agent>;
interface Session {
    agent: Agent;
    csrf: string;
}

const actor = new StubActor();
let t: TestApp;

async function login(username: string, password: string): Promise<Session> {
    const agent = request.agent(t.server);
    const res = await agent.post('/api/auth/login').send({ username, password }).expect(200);
    return { agent, csrf: res.body.csrfToken as string };
}

/** creates a user with a final password (the temporary one must be changed before anything else) */
async function userWithRole(admin: Session, username: string, role: 'viewer' | 'operator'): Promise<Session> {
    const temp = 'Temp-Password-9876';
    const final = `${role}-Chosen-Pass-42`;
    await admin.agent
        .post('/api/users')
        .set('x-csrf-token', admin.csrf)
        .send({ username, name: username, role, password: temp })
        .expect(201);
    const first = await login(username, temp);
    await first.agent
        .post('/api/auth/change-password')
        .set('x-csrf-token', first.csrf)
        .send({ currentPassword: temp, newPassword: final })
        .expect(204);
    return login(username, final);
}

const auditList = async () =>
    (await t.get<any>('audit/audit.service.js#AuditService').list(50)).items as Array<Record<string, any>>;

before(async () => {
    await actor.start();
    t = await startApp({ ACTOR_URL: `${actor.url}/` });
});
after(async () => {
    await t.close();
    await actor.stop();
});

describe('actor bridge', () => {
    let admin: Session;
    let viewer: Session;
    let operator: Session;
    before(async () => {
        await t.resetData();
        admin = await login(ADMIN.username, ADMIN.password);
        viewer = await userWithRole(admin, 'vic', 'viewer');
        operator = await userWithRole(admin, 'ola', 'operator');
    });
    beforeEach(() => {
        actor.seen = [];
        actor.mode = 'ok';
        actor.engine = { isRunning: false, symbols: ['XAUUSD'], mode: 'Sonic' };
    });
    afterEach(() => {
        actor.mode = 'ok';
    });

    it('needs a session', async () => {
        await request(t.server).get('/api/actor/state').expect(401);
        await request(t.server).get('/api/actor/logs').expect(401);
        // the machine API key is not accepted by the dashboard API either
        await request(t.server).get('/api/actor/state').set('x-api-key', API_KEY).expect(401);
        assert.equal(actor.seen.length, 0);
    });

    it('a viewer can read state and logs; key and user are sent to the Actor', async () => {
        const state = (await viewer.agent.get('/api/actor/state').expect(200)).body;
        assert.equal(state.available, true);
        assert.equal(state.isRunning, false);
        assert.deepEqual(state.symbols, ['XAUUSD']);
        assert.equal(state.mode, 'Sonic');
        assert.equal(state.maxPositions, 1);
        assert.ok(state.modes.includes('Scalper'));
        assert.equal(state.symbolsLive[0].price, 4001.5);
        const [call] = actor.seen;
        assert.equal(call.url, '/api/machine/engine', 'the trailing slash of ACTOR_URL is dropped');
        assert.equal(call.headers['x-api-key'], API_KEY);
        assert.equal(call.headers['x-actor-user'], 'vic');
        assert.equal(call.headers.cookie, undefined, 'browser cookies are not forwarded');

        const logs = (await viewer.agent.get('/api/actor/logs?after=1&limit=50').expect(200)).body;
        assert.deepEqual(logs, { latestId: 2, entries: [actor.logs[1]] });
        assert.equal(actor.seen[1].url, '/api/machine/logs?after=1&limit=50');

        const defaults = (await viewer.agent.get('/api/actor/logs').expect(200)).body;
        assert.equal(defaults.entries.length, 2);
        assert.equal(actor.seen[2].url, '/api/machine/logs?after=0&limit=200');
    });

    it('log queries are validated before reaching the Actor', async () => {
        for (const q of ['after=-1', 'after=x', 'limit=0', 'limit=501', 'limit=2.5', 'other=1']) {
            await viewer.agent.get(`/api/actor/logs?${q}`).expect(400);
        }
        assert.equal(actor.seen.length, 0);
    });

    it('a viewer cannot start or stop (403), nothing reaches the Actor', async () => {
        await viewer.agent
            .post('/api/actor/start')
            .set('x-csrf-token', viewer.csrf)
            .send({ symbols: ['XAUUSD'], mode: 'sonic' })
            .expect(403);
        await viewer.agent.post('/api/actor/stop').set('x-csrf-token', viewer.csrf).expect(403);
        assert.equal(actor.seen.length, 0);
    });

    it('start and stop need the CSRF token', async () => {
        await operator.agent
            .post('/api/actor/start')
            .send({ symbols: ['XAUUSD'], mode: 'sonic' })
            .expect(403);
        await operator.agent.post('/api/actor/stop').set('x-csrf-token', 'forged').expect(403);
        assert.equal(actor.seen.length, 0);
    });

    it('an operator can start and stop; both are proxied and audited', async () => {
        const started = await operator.agent
            .post('/api/actor/start')
            .set('x-csrf-token', operator.csrf)
            .send({ symbols: ['XAUUSD', 'EURUSD'], mode: 'scalper' })
            .expect(201);
        assert.deepEqual(started.body, {
            ok: true,
            state: { isRunning: true, symbols: ['XAUUSD', 'EURUSD'], mode: 'Scalper' },
        });
        const [call] = actor.seen;
        assert.equal(call.method, 'POST');
        assert.equal(call.url, '/api/machine/engine/start');
        assert.deepEqual(call.body, { symbols: ['XAUUSD', 'EURUSD'], mode: 'scalper' });
        assert.equal(call.headers['x-actor-user'], 'ola');

        const stopped = await operator.agent.post('/api/actor/stop').set('x-csrf-token', operator.csrf).expect(201);
        assert.equal(stopped.body.state.isRunning, false);
        assert.equal(actor.seen[1].url, '/api/machine/engine/stop');

        const events = await auditList();
        const start = events.find((e) => e.action === 'actor.start');
        assert.ok(start, 'start audited');
        assert.equal(start.success, true);
        assert.equal(start.actor.username, 'ola');
        assert.equal(start.target, 'XAUUSD,EURUSD');
        assert.deepEqual(start.detail, { symbols: ['XAUUSD', 'EURUSD'], mode: 'scalper' });
        const stop = events.find((e) => e.action === 'actor.stop');
        assert.ok(stop, 'stop audited');
        assert.equal(stop.success, true);
        assert.equal(stop.actor.username, 'ola');
    });

    it('the admin counts as operator', async () => {
        await admin.agent.post('/api/actor/stop').set('x-csrf-token', admin.csrf).expect(201);
    });

    it('start bodies are shape-checked before reaching the Actor', async () => {
        for (const body of [
            {},
            { symbols: [], mode: 'sonic' },
            { symbols: ['xauusd'], mode: 'sonic' },
            { symbols: ['XAU/USD'], mode: 'sonic' },
            { symbols: ['A'.repeat(21)], mode: 'sonic' },
            { symbols: Array(11).fill('XAUUSD'), mode: 'sonic' },
            { symbols: ['XAUUSD'] },
            { symbols: ['XAUUSD'], mode: 'x'.repeat(21) },
            { symbols: 'XAUUSD', mode: 'sonic' },
            { symbols: ['XAUUSD'], mode: 'sonic', extra: true },
        ]) {
            const res = await operator.agent.post('/api/actor/start').set('x-csrf-token', operator.csrf).send(body);
            assert.equal(res.status, 400, JSON.stringify(body));
        }
        assert.equal(actor.seen.length, 0);
    });

    it("the Actor's own 400 is passed through and audited as a failure", async () => {
        const res = await operator.agent
            .post('/api/actor/start')
            .set('x-csrf-token', operator.csrf)
            .send({ symbols: ['XAUUSD'], mode: 'warp' })
            .expect(400);
        assert.equal(res.body.error, 'unknown mode');
        assert.equal(res.body.message, 'unknown mode');
        const ev = (await auditList()).find((e) => e.action === 'actor.start' && e.success === false);
        assert.ok(ev, 'failure audited');
        assert.equal(ev.detail.mode, 'warp');
        assert.equal(ev.detail.error, 'unknown mode');
    });

    it('Actor down: reads report unavailable (200), writes answer 502 and are audited', async () => {
        actor.mode = 'down';
        const state = (await viewer.agent.get('/api/actor/state').expect(200)).body;
        assert.deepEqual(state, { available: false, reason: 'Actor unreachable' });
        const logs = (await viewer.agent.get('/api/actor/logs').expect(200)).body;
        assert.deepEqual(logs, { available: false, reason: 'Actor unreachable' });

        const res = await operator.agent.post('/api/actor/stop').set('x-csrf-token', operator.csrf).expect(502);
        assert.equal(res.body.error, 'Actor unreachable');
        const ev = (await auditList()).find((e) => e.action === 'actor.stop' && e.success === false);
        assert.ok(ev, 'failure audited');
        assert.equal(ev.detail.error, 'Actor unreachable');

        actor.mode = 'ok';
        assert.equal((await viewer.agent.get('/api/actor/state').expect(200)).body.available, true);
    });

    it('Actor rejecting the API key is reported as such, not as a login problem', async () => {
        actor.mode = 'wrong-key';
        const state = (await viewer.agent.get('/api/actor/state').expect(200)).body;
        assert.deepEqual(state, { available: false, reason: 'Actor rejected the API key' });
        const res = await operator.agent
            .post('/api/actor/start')
            .set('x-csrf-token', operator.csrf)
            .send({ symbols: ['XAUUSD'], mode: 'sonic' })
            .expect(502);
        assert.equal(res.body.error, 'Actor rejected the API key');
    });

    it('Actor process gone (port closed): unavailable / 502', async () => {
        await actor.stop();
        try {
            const state = (await viewer.agent.get('/api/actor/state').expect(200)).body;
            assert.deepEqual(state, { available: false, reason: 'Actor unreachable' });
            const res = await operator.agent
                .post('/api/actor/start')
                .set('x-csrf-token', operator.csrf)
                .send({ symbols: ['XAUUSD'], mode: 'sonic' })
                .expect(502);
            assert.equal(res.body.error, 'Actor unreachable');
        } finally {
            const port = Number(new URL(actor.url).port);
            await new Promise<void>((resolve) => actor.server.listen(port, '127.0.0.1', resolve));
        }
    });
});
