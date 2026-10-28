import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startHarness } from './helpers/harness.js';
import { STUB_API_KEY } from './helpers/stubService.js';

describe('gold proxy', () => {
    let h;
    let viewer;
    let operator;
    before(async () => {
        h = await startHarness();
        viewer = await h.login('victor');
        operator = await h.login('olivia');
    });
    after(() => h.close());
    beforeEach(() => h.stub.reset());

    test('requires a session', async () => {
        assert.equal((await h.request('/api/gold/status')).status, 401);
        assert.equal(h.stub.calls('/gold').length, 0);
    });

    test('viewer can read; the API key is added server-side', async () => {
        const r = await h.request('/api/gold/status', { cookie: viewer.cookie });
        assert.equal(r.status, 200);
        assert.equal(r.body.accountMode, 'DEMO');
        const [call] = h.stub.calls('/gold/status');
        assert.equal(call.headers['x-api-key'], STUB_API_KEY);
        assert.equal(call.headers.cookie, undefined, 'browser cookies are not forwarded');
        assert.equal(call.headers['x-actor-user'], undefined, 'reads carry no actor');
    });

    for (const [path, body] of [
        ['/api/gold/run', { mode: 'swing', force: true }],
        ['/api/gold/automate', { enabled: true, modes: ['swing'] }],
        ['/api/gold/settings', { risk_usd_per_trade: '50' }],
    ]) {
        test(`viewer gets 403 on POST ${path}`, async () => {
            const r = await h.request(path, { method: 'POST', cookie: viewer.cookie, csrf: viewer.csrf, body });
            assert.equal(r.status, 403);
            assert.equal(h.stub.calls('/gold').length, 0);
        });

        test(`operator can POST ${path}`, async () => {
            const r = await h.request(path, { method: 'POST', cookie: operator.cookie, csrf: operator.csrf, body });
            assert.equal(r.status, 201);
            const [call] = h.stub.calls(path.replace('/api', ''));
            assert.deepEqual(call.body, body);
            assert.equal(call.headers['x-actor-user'], 'olivia', 'the service can audit who acted');
        });
    }

    test('admin counts as operator', async () => {
        const admin = await h.login('adam');
        const r = await h.request('/api/gold/automate', {
            method: 'POST',
            cookie: admin.cookie,
            csrf: admin.csrf,
            body: { enabled: false },
        });
        assert.equal(r.status, 201);
    });

    test('write bodies are validated before reaching the service', async () => {
        const post = (path, body) =>
            h.request(path, { method: 'POST', cookie: operator.cookie, csrf: operator.csrf, body });
        for (const [path, body] of [
            ['/api/gold/run', {}],
            ['/api/gold/run', { mode: '../x' }],
            ['/api/gold/run', { mode: 'swing', force: 'yes' }],
            ['/api/gold/run', { mode: 'swing', symbol: 'XAUUSD', extra: 1 }],
            ['/api/gold/run', ['swing']],
            ['/api/gold/automate', { enabled: 'true' }],
            ['/api/gold/automate', { enabled: true, modes: ['swing', '<script>'] }],
            ['/api/gold/automate', { enabled: true, instruments: Array(11).fill('XAUUSD') }],
            ['/api/gold/settings', {}],
            ['/api/gold/settings', { risk_usd_per_trade: { $gt: 1 } }],
            ['/api/gold/settings', { 'bad key': 1 }],
            ['/api/gold/settings', '{"__proto__":{"polluted":true}}'],
        ]) {
            const r = await post(path, body);
            assert.equal(r.status, 400, `${path} ${JSON.stringify(body)} -> ${r.status}`);
        }
        const invalidJson = await h.request('/api/gold/run', {
            method: 'POST',
            cookie: operator.cookie,
            csrf: operator.csrf,
            body: '{"mode":',
        });
        assert.equal(invalidJson.status, 400);
        assert.equal(h.stub.calls('/gold').length, 0);
    });

    test('archive file: a valid path is forwarded, encoded and with full=1', async () => {
        const r = await h.request('/api/gold/archive/swing/20260101_120000_swing.json?full=1', {
            cookie: viewer.cookie,
        });
        assert.equal(r.status, 200);
        const [call] = h.stub.calls('/gold/archive/');
        assert.equal(call.url, '/gold/archive/swing/20260101_120000_swing.json?full=1');
    });

    test('archive file: path traversal and odd names are rejected', async () => {
        for (const path of [
            '/api/gold/archive/..%2F..%2Fetc/passwd.json',
            '/api/gold/archive/swing/..%2F..%2F.env',
            '/api/gold/archive/swing/..%2F..%2Fsecrets.json',
            '/api/gold/archive/%2e%2e/x.json',
            '/api/gold/archive/swing/%2e%2e',
            '/api/gold/archive/swing/x.json%00.txt',
            '/api/gold/archive/swing/.hidden.json',
            '/api/gold/archive/swing/a..json',
            '/api/gold/archive/SWING%5C..%5C/x.json',
            '/api/gold/archive/swing/x.json?full=maybe',
            '/api/gold/archive/../../etc/passwd',
            '/api/gold/archive/swing/../../../.env',
        ]) {
            const r = await h.rawGet(path, { cookie: viewer.cookie });
            assert.ok([400, 404].includes(r.status), `${path} -> ${r.status}`);
        }
        assert.equal(h.stub.calls('/gold').length, 0, 'nothing reached the service');
    });

    test('query parameters are validated and rebuilt', async () => {
        const get = (path) => h.request(path, { cookie: viewer.cookie });
        assert.equal((await get('/api/gold/archive?limit=abc')).status, 400);
        assert.equal((await get('/api/gold/archive?limit=500')).status, 400);
        assert.equal((await get('/api/gold/news?limit=0')).status, 400);
        assert.equal((await get('/api/gold/activity?after=-1')).status, 400);
        assert.equal(h.stub.calls('/gold').length, 0);

        assert.equal((await get('/api/gold/archive?limit=8&mode=../../x')).status, 200);
        assert.equal(h.stub.calls('/gold/archive')[0].search, '?limit=8', 'unknown params are dropped');
        assert.equal((await get('/api/gold/activity')).status, 200);
        assert.equal(h.stub.calls('/gold/activity')[0].search, '?after=0');
    });

    test('unknown /api routes are 404 JSON', async () => {
        const r = await h.request('/api/gold/nope', { cookie: viewer.cookie });
        assert.equal(r.status, 404);
        assert.deepEqual(r.body, { error: 'not found' });
    });
});

describe('public endpoints and headers', () => {
    let h;
    before(async () => {
        h = await startHarness();
    });
    after(() => h.close());

    test('GET /health needs no auth', async () => {
        const r = await h.request('/health');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { status: 'ok' });
    });

    test('dashboard is served with a strict CSP and security headers', async () => {
        const res = await fetch(h.base + '/');
        assert.equal(res.status, 200);
        const html = await res.text();
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /script-src 'self'(;|$)/);
        assert.match(csp, /style-src 'self'(;|$)/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /object-src 'none'/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-powered-by'), null);
        assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline <script> blocks');
        assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
        assert.doesNotMatch(html, /\sstyle=/i, 'no inline style attributes');
        assert.match(html, /<script type="module" src="\/app.js">/);
    });
});
