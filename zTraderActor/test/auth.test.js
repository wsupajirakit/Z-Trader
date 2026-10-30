import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ABSOLUTE_TTL_MS, IDLE_TTL_MS } from '../src/auth/SessionStore.js';
import { startHarness } from './helpers/harness.js';
import { PASSWORD, STUB_API_KEY } from './helpers/stubService.js';

describe('login, /me, logout', () => {
    let h;
    before(async () => {
        h = await startHarness();
    });
    after(() => h.close());
    beforeEach(() => h.stub.reset());

    test('successful login returns the user and a CSRF token and calls the service verify contract', async () => {
        const r = await h.request('/login', {
            method: 'POST',
            body: { username: '  Olivia ', password: PASSWORD },
            headers: { 'user-agent': 'node-test' },
        });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.user, { id: 'u-op', username: 'olivia', name: 'Olivia Operator', role: 'operator' });
        assert.match(r.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);

        const [call] = h.stub.calls('/api/v1/auth/verify');
        assert.equal(call.method, 'POST');
        assert.equal(call.headers['x-api-key'], STUB_API_KEY);
        assert.deepEqual(Object.keys(call.body).sort(), ['clientIp', 'password', 'userAgent', 'username']);
        assert.equal(call.body.username, 'olivia', 'username is trimmed and lower-cased');
        assert.equal(call.body.userAgent, 'node-test');
        assert.ok(call.body.clientIp);
    });

    test('wrong password is 401 and sets no cookie', async () => {
        const r = await h.request('/login', { method: 'POST', body: { username: 'olivia', password: 'nope' } });
        assert.equal(r.status, 401);
        assert.equal(r.res.headers.get('set-cookie'), null);
    });

    test('malformed username is 401 without calling the service', async () => {
        const r = await h.request('/login', { method: 'POST', body: { username: 'no spaces!', password: 'x' } });
        assert.equal(r.status, 401);
        assert.equal(h.stub.calls('/api/v1/auth/verify').length, 0);
    });

    test('missing fields are 400', async () => {
        const r = await h.request('/login', { method: 'POST', body: { username: 'olivia' } });
        assert.equal(r.status, 400);
    });

    test('429 (service rate limit) is passed through as "too many attempts", not as a lockout', async () => {
        const r = await h.request('/login', { method: 'POST', body: { username: 'ratelimited', password: PASSWORD } });
        assert.equal(r.status, 429);
        assert.equal(r.body.error, 'too many attempts, try again later');
        assert.doesNotMatch(JSON.stringify(r.body), /lock/i);
        assert.equal(r.body.retryAfterSec, 900);
        assert.equal(r.res.headers.get('retry-after'), '900');
    });

    test('a locked account is a plain 401, indistinguishable from a bad password', async () => {
        const r = await h.request('/login', { method: 'POST', body: { username: 'locked', password: PASSWORD } });
        assert.equal(r.status, 401);
        assert.deepEqual(r.body, { error: 'invalid username or password' });
    });

    test('a very long User-Agent is cut to the service limit (300) so login still works', async () => {
        h.stub.reset();
        const r = await h.request('/login', {
            method: 'POST',
            body: { username: 'olivia', password: PASSWORD },
            headers: { 'user-agent': 'Mozilla/5.0 '.repeat(100) },
        });
        assert.equal(r.status, 200);
        const [call] = h.stub.calls('/api/v1/auth/verify');
        assert.equal(call.body.userAgent.length, 300);
        assert.ok(call.body.clientIp.length <= 64);
    });

    test('a password over the service limit (128) is rejected before calling the service', async () => {
        h.stub.reset();
        const r = await h.request('/login', {
            method: 'POST',
            body: { username: 'olivia', password: 'x'.repeat(129) },
        });
        assert.equal(r.status, 400);
        assert.equal(h.stub.calls('/api/v1/auth/verify').length, 0);
    });

    test('mustChangePassword is refused with a message pointing to the main dashboard', async () => {
        const r = await h.request('/login', { method: 'POST', body: { username: 'newbie', password: PASSWORD } });
        assert.equal(r.status, 403);
        assert.equal(r.body.error, 'PASSWORD_CHANGE_REQUIRED');
        assert.match(r.body.message, /change your password on the main Z Trader dashboard/);
        assert.equal(r.res.headers.get('set-cookie'), null);
        assert.ok(![...h.actor.sessions.sessions.values()].some((s) => s.user.username === 'newbie'));
    });

    test('service failure is a 502 without details', async () => {
        const r = await h.request('/login', { method: 'POST', body: { username: 'broken', password: PASSWORD } });
        assert.equal(r.status, 502);
        assert.deepEqual(r.body, { error: 'authentication service unavailable' });
    });

    test('cookie over plain HTTP: HttpOnly, SameSite=Strict, Path=/, no Secure, no __Host- prefix', async () => {
        const { setCookie } = await h.login();
        assert.match(setCookie, /^zta_session=[A-Za-z0-9_-]{43};/);
        assert.match(setCookie, /; HttpOnly/);
        assert.match(setCookie, /; SameSite=Strict/);
        assert.match(setCookie, /; Path=\//);
        assert.match(setCookie, /; Max-Age=43200/);
        assert.doesNotMatch(setCookie, /Secure/);
        assert.doesNotMatch(setCookie, /Domain=/i);
    });

    test('X-Forwarded-Proto is ignored when TRUST_PROXY=0', async () => {
        const { setCookie } = await h.login('olivia', PASSWORD, { headers: { 'x-forwarded-proto': 'https' } });
        assert.match(setCookie, /^zta_session=/);
    });

    test('/me returns the user and CSRF token; 401 without a session', async () => {
        const { cookie, csrf } = await h.login('victor');
        const me = await h.request('/me', { cookie });
        assert.equal(me.status, 200);
        assert.equal(me.body.user.role, 'viewer');
        assert.equal(me.body.csrfToken, csrf);
        assert.equal(me.res.headers.get('cache-control'), 'no-store');

        assert.equal((await h.request('/me')).status, 401);
        assert.equal((await h.request('/me', { cookie: 'zta_session=forged' })).status, 401);
    });

    test('logout needs CSRF, then revokes the session server-side', async () => {
        const { cookie, csrf } = await h.login();
        assert.equal((await h.request('/logout', { method: 'POST', cookie })).status, 403);

        const out = await h.request('/logout', { method: 'POST', cookie, csrf });
        assert.equal(out.status, 204);
        assert.match(out.res.headers.get('set-cookie'), /^zta_session=;/);

        // the old cookie no longer works even if the browser kept it
        assert.equal((await h.request('/me', { cookie })).status, 401);
    });

    test('logging in again replaces the previous session (no fixation)', async () => {
        const first = await h.login();
        const second = await h.login('olivia', PASSWORD, { headers: { cookie: first.cookie } });
        assert.notEqual(first.cookie, second.cookie);
        assert.equal((await h.request('/me', { cookie: first.cookie })).status, 401);
        assert.equal((await h.request('/me', { cookie: second.cookie })).status, 200);
    });

    test('oversized bodies are rejected with 413', async () => {
        const big = JSON.stringify({ username: 'olivia', password: 'x'.repeat(40 * 1024) });
        const r = await h.request('/login', { method: 'POST', body: big });
        assert.equal(r.status, 413);
    });
});

describe('session lifetime (injected clock)', () => {
    let h;
    before(async () => {
        h = await startHarness();
    });
    after(() => h.close());

    test('idle timeout: 2 h without a request ends the session', async () => {
        const { cookie } = await h.login();
        h.clock.advance(IDLE_TTL_MS - 1000);
        assert.equal((await h.request('/me', { cookie })).status, 200, 'still alive just before idle timeout');
        h.clock.advance(IDLE_TTL_MS - 1000);
        assert.equal((await h.request('/me', { cookie })).status, 200, 'activity refreshed the idle timer');
        h.clock.advance(IDLE_TTL_MS);
        assert.equal((await h.request('/me', { cookie })).status, 401);
    });

    test('absolute timeout: 12 h after login even with constant activity', async () => {
        const { cookie } = await h.login();
        const step = 60 * 60 * 1000;
        for (let elapsed = step; elapsed < ABSOLUTE_TTL_MS; elapsed += step) {
            h.clock.advance(step);
            assert.equal((await h.request('/me', { cookie })).status, 200, `alive at ${elapsed / step} h`);
        }
        h.clock.advance(step);
        assert.equal((await h.request('/me', { cookie })).status, 401);
    });

    test('sweep removes expired sessions from memory', async () => {
        await h.login();
        assert.ok(h.actor.sessions.size > 0);
        h.clock.advance(ABSOLUTE_TTL_MS);
        h.actor.sessions.sweep();
        assert.equal(h.actor.sessions.size, 0);
    });
});

describe('HTTPS behind a trusted proxy', () => {
    let h;
    before(async () => {
        h = await startHarness({ env: { TRUST_PROXY: '1' } });
    });
    after(() => h.close());

    test('cookie uses the __Host- prefix and Secure', async () => {
        const opts = { headers: { 'x-forwarded-proto': 'https' } };
        const { setCookie, cookie } = await h.login('olivia', PASSWORD, opts);
        assert.match(setCookie, /^__Host-zta_session=[A-Za-z0-9_-]{43};/);
        assert.match(setCookie, /; Secure/);
        assert.match(setCookie, /; HttpOnly/);
        assert.match(setCookie, /; SameSite=Strict/);
        assert.match(setCookie, /; Path=\//);
        assert.doesNotMatch(setCookie, /Domain=/i);

        assert.equal((await h.request('/me', { cookie, ...opts })).status, 200);
        // the secure cookie is not accepted over plain HTTP, and vice versa
        assert.equal((await h.request('/me', { cookie })).status, 401);
    });
});

describe('CSRF and Origin checks', () => {
    let h;
    before(async () => {
        h = await startHarness();
    });
    after(() => h.close());

    test('writes without, or with a wrong, X-CSRF-Token are 403 and never reach the service', async () => {
        const { cookie, csrf } = await h.login();
        h.stub.reset();
        const body = { mode: 'swing', force: true };
        assert.equal((await h.request('/api/gold/run', { method: 'POST', cookie, body })).status, 403);
        const wrong = csrf.slice(0, -1) + (csrf.endsWith('A') ? 'B' : 'A');
        assert.equal((await h.request('/api/gold/run', { method: 'POST', cookie, csrf: wrong, body })).status, 403);
        assert.equal(h.stub.calls('/gold').length, 0);

        const ok = await h.request('/api/gold/run', { method: 'POST', cookie, csrf, body });
        assert.equal(ok.status, 201);
        assert.deepEqual(h.stub.calls('/gold/run')[0].body, body);
    });

    test("a CSRF token from another session doesn't work", async () => {
        const a = await h.login('olivia');
        const b = await h.login('adam');
        const r = await h.request('/api/gold/run', {
            method: 'POST',
            cookie: a.cookie,
            csrf: b.csrf,
            body: { mode: 'swing' },
        });
        assert.equal(r.status, 403);
    });

    test('Origin mismatch is rejected, including on login', async () => {
        h.stub.reset();
        const login = await h.request('/login', {
            method: 'POST',
            origin: 'http://evil.example',
            body: { username: 'olivia', password: PASSWORD },
        });
        assert.equal(login.status, 403);
        assert.equal(h.stub.calls('/api/v1/auth/verify').length, 0);

        const { cookie, csrf } = await h.login();
        const run = await h.request('/api/gold/run', {
            method: 'POST',
            cookie,
            csrf,
            origin: 'http://evil.example',
            body: { mode: 'swing' },
        });
        assert.equal(run.status, 403);
        const nullOrigin = await h.request('/api/gold/run', {
            method: 'POST',
            cookie,
            csrf,
            origin: 'null',
            body: { mode: 'swing' },
        });
        assert.equal(nullOrigin.status, 403);
    });

    test('cross-site Sec-Fetch-Site without Origin is rejected', async () => {
        const { cookie, csrf } = await h.login();
        const r = await h.request('/api/gold/run', {
            method: 'POST',
            cookie,
            csrf,
            origin: null,
            headers: { 'sec-fetch-site': 'cross-site' },
            body: { mode: 'swing' },
        });
        assert.equal(r.status, 403);
    });
});

describe('login rate limit', () => {
    let h;
    before(async () => {
        h = await startHarness({ loginRateLimit: { windowMs: 60_000, limit: 3 } });
    });
    after(() => h.close());

    test('failed attempts per IP are limited; successful ones do not count', async () => {
        await h.login(); // success: not counted
        for (let i = 0; i < 3; i++) {
            const r = await h.request('/login', { method: 'POST', body: { username: 'olivia', password: 'bad' } });
            assert.equal(r.status, 401);
        }
        const limited = await h.request('/login', { method: 'POST', body: { username: 'olivia', password: PASSWORD } });
        assert.equal(limited.status, 429);
        assert.ok(limited.body.retryAfterSec > 0);
    });
});
