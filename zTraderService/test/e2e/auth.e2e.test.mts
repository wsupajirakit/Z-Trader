/**
 * Browser authentication end to end: login, cookie flags, CSRF, lockout, password change, sessions,
 * roles. Each `describe` boots its own app + database so the cases cannot leak state into each other.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ADMIN, API_KEY, startApp, type TestApp } from './helpers/app.mts';

let t: TestApp;
before(async () => {
    t = await startApp();
});
after(async () => {
    await t.close();
});

type Agent = ReturnType<typeof request.agent>;

async function login(
    t: TestApp,
    username: string,
    password: string,
): Promise<{ agent: Agent; csrf: string; body: any }> {
    const agent = request.agent(t.server);
    const res = await agent.post('/api/auth/login').send({ username, password }).expect(200);
    return { agent, csrf: res.body.csrfToken, body: res.body };
}

async function createUser(
    admin: { agent: Agent; csrf: string },
    username: string,
    role: string,
    password = 'Temp-Password-9876',
) {
    const res = await admin.agent
        .post('/api/users')
        .set('x-csrf-token', admin.csrf)
        .send({ username, name: username, role, password })
        .expect(201);
    return res.body;
}

describe('login and session cookie', () => {
    before(async () => {
        await t.resetData();
    });

    it('health probes are public and say nothing else', async () => {
        assert.deepEqual((await request(t.server).get('/health').expect(200)).body, { status: 'ok' });
        assert.deepEqual((await request(t.server).get('/health/ready').expect(200)).body, { status: 'ok' });
    });

    it('everything else needs a session', async () => {
        for (const path of ['/api/auth/me', '/api/dashboard/status', '/api/users', '/api/audit']) {
            await request(t.server).get(path).expect(401);
        }
    });

    it('wrong password and unknown user get the same 401', async () => {
        const a = await request(t.server)
            .post('/api/auth/login')
            .send({ username: ADMIN.username, password: 'nope-nope-nope' })
            .expect(401);
        const b = await request(t.server)
            .post('/api/auth/login')
            .send({ username: 'ghost', password: 'nope-nope-nope' })
            .expect(401);
        assert.equal(a.body.message, b.body.message);
    });

    it('rejects unknown fields in the body', async () => {
        await request(t.server)
            .post('/api/auth/login')
            .send({ ...ADMIN, isAdmin: true })
            .expect(400);
    });

    it('sets an HttpOnly SameSite=Strict cookie and returns user + csrf token', async () => {
        const res = await request(t.server).post('/api/auth/login').send(ADMIN).expect(200);
        const cookie = String(res.headers['set-cookie']);
        assert.match(cookie, /^zt_session=/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        assert.match(cookie, /Path=\//);
        assert.doesNotMatch(cookie, /Secure/, 'plain http must not get a Secure cookie');
        assert.equal(res.body.user.username, ADMIN.username);
        assert.equal(res.body.user.role, 'admin');
        assert.equal(typeof res.body.csrfToken, 'string');
        assert.ok(!('passwordHash' in res.body.user));
    });

    it('ignores X-Forwarded-Proto when no proxy is trusted (TRUST_PROXY=0)', async () => {
        const res = await request(t.server)
            .post('/api/auth/login')
            .set('x-forwarded-proto', 'https')
            .send(ADMIN)
            .expect(200);
        assert.match(String(res.headers['set-cookie']), /^zt_session=/);
    });

    it('/me returns the same user and csrf token', async () => {
        const s = await login(t, ADMIN.username, ADMIN.password);
        const me = await s.agent.get('/api/auth/me').expect(200);
        assert.equal(me.body.user.username, ADMIN.username);
        assert.equal(me.body.csrfToken, s.csrf);
    });

    it('security headers are present', async () => {
        const res = await request(t.server).get('/health');
        assert.match(String(res.headers['content-security-policy']), /script-src 'self'/);
        assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-powered-by'], undefined);
    });

    it('logout revokes the session server-side', async () => {
        const s = await login(t, ADMIN.username, ADMIN.password);
        await s.agent.post('/api/auth/logout').set('x-csrf-token', s.csrf).expect(204);
        await s.agent.get('/api/auth/me').expect(401);
    });

    it('a JSON cookie (cookie-parser "j:" form) is no session: 401, not 500', async () => {
        await request(t.server).get('/api/auth/me').set('Cookie', 'zt_session=j:{"a":1}').expect(401);
        await request(t.server).get('/api/auth/me').set('Cookie', 'zt_session=j:["x"]').expect(401);
        await request(t.server)
            .get('/api/auth/me')
            .set('Cookie', `zt_session=${'a'.repeat(500)}`)
            .expect(401);
    });

    it('login with a junk "j:" cookie still works and leaves exactly one new session', async () => {
        const sessions = t.collection('sessions');
        const before = await sessions.countDocuments({});
        const res = await request(t.server).post('/api/auth/login').set('Cookie', 'zt_session=j:[1]').send(ADMIN);
        assert.equal(res.status, 200);
        assert.match(String(res.headers['set-cookie']), /^zt_session=/);
        assert.equal(await sessions.countDocuments({}), before + 1);
    });

    it('login revokes the session cookie the browser already had', async () => {
        const s = await login(t, ADMIN.username, ADMIN.password);
        const sessions = t.collection('sessions');
        const before = await sessions.countDocuments({});
        await s.agent.post('/api/auth/login').send(ADMIN).expect(200);
        assert.equal(await sessions.countDocuments({}), before, 'the old session is replaced, not kept');
    });
});

describe('account lockout', () => {
    before(async () => {
        await t.resetData();
    });

    const wrong = (i: number) => ({ username: ADMIN.username, password: `wrong-pass-${i}-xxxx` });

    it('20 parallel wrong passwords lock the account (the count is atomic)', async () => {
        const rs = await Promise.all(
            Array.from({ length: 20 }, (_, i) => request(t.server).post('/api/auth/login').send(wrong(i))),
        );
        assert.deepEqual(new Set(rs.map((r) => r.status)), new Set([401]));
        const stored = await t.collection('users').findOne({ username: ADMIN.username });
        assert.ok(stored?.lockedUntil instanceof Date && stored.lockedUntil.getTime() > Date.now(), 'locked');
        // the right password is refused while the lock holds
        await request(t.server).post('/api/auth/login').send(ADMIN).expect(401);
        await request(t.server).post('/api/v1/auth/verify').set('x-api-key', API_KEY).send(ADMIN).expect(401);
    });

    it('a locked account answers exactly like an unknown user and a wrong password', async () => {
        const locked = await request(t.server).post('/api/auth/login').send(ADMIN);
        const unknown = await request(t.server)
            .post('/api/auth/login')
            .send({ username: 'nobody-here', password: ADMIN.password });
        assert.equal(locked.status, unknown.status);
        assert.deepEqual(locked.body, unknown.body);
        assert.ok(!('retryAfterSec' in locked.body));

        const vLocked = await request(t.server).post('/api/v1/auth/verify').set('x-api-key', API_KEY).send(ADMIN);
        const vUnknown = await request(t.server)
            .post('/api/v1/auth/verify')
            .set('x-api-key', API_KEY)
            .send({ username: 'nobody-here', password: ADMIN.password });
        assert.equal(vLocked.status, 401);
        assert.equal(vLocked.status, vUnknown.status);
        assert.deepEqual(vLocked.body, vUnknown.body);
    });

    it('the lock and its refusals are in the audit log', async () => {
        const auth = t.get<{ now: () => number }>('auth/auth.service.js#AuthService');
        auth.now = () => Date.now() + 16 * 60_000;
        try {
            const s = await login(t, ADMIN.username, ADMIN.password);
            const audit = await s.agent.get('/api/audit?limit=200').expect(200);
            const items = audit.body.items as { action: string; detail: Record<string, unknown> | null }[];
            assert.ok(items.some((e) => e.action === 'auth.login_locked'));
            assert.ok(items.some((e) => e.action === 'auth.verify_actor_locked'));
            assert.ok(items.some((e) => e.action === 'auth.login_failed' && e.detail?.locked === true));
        } finally {
            auth.now = Date.now;
        }
    });
});

describe('CSRF', () => {
    let s: { agent: Agent; csrf: string };
    before(async () => {
        await t.resetData();
        s = await login(t, ADMIN.username, ADMIN.password);
    });

    it('a write without the token is refused', async () => {
        await s.agent.post('/api/dashboard/daily-stop/reset').expect(403);
    });

    it('a write with a wrong token is refused', async () => {
        await s.agent.post('/api/dashboard/daily-stop/reset').set('x-csrf-token', 'x'.repeat(43)).expect(403);
    });

    it('a write from another origin is refused even with the token', async () => {
        await s.agent
            .post('/api/dashboard/daily-stop/reset')
            .set('x-csrf-token', s.csrf)
            .set('origin', 'https://evil.example')
            .expect(403);
    });

    it('a write with the token is accepted', async () => {
        await s.agent.post('/api/dashboard/daily-stop/reset').set('x-csrf-token', s.csrf).expect(201);
    });
});

describe('roles, temporary passwords and session revocation', () => {
    let admin: { agent: Agent; csrf: string };
    before(async () => {
        await t.resetData();
        admin = await login(t, ADMIN.username, ADMIN.password);
    });

    it('a new user must change the temporary password before anything else', async () => {
        await createUser(admin, 'vera', 'viewer');
        const v = await login(t, 'vera', 'Temp-Password-9876');
        assert.equal(v.body.user.mustChangePassword, true);
        const blocked = await v.agent.get('/api/dashboard/status').expect(403);
        assert.equal(blocked.body.message, 'PASSWORD_CHANGE_REQUIRED');
        await v.agent.get('/api/auth/me').expect(200);

        await v.agent
            .post('/api/auth/change-password')
            .set('x-csrf-token', v.csrf)
            .send({ currentPassword: 'Temp-Password-9876', newPassword: 'short' })
            .expect(400);
        await v.agent
            .post('/api/auth/change-password')
            .set('x-csrf-token', v.csrf)
            .send({ currentPassword: 'Temp-Password-9876', newPassword: 'vera-likes-long-ones' })
            .expect(400); // contains username
        await v.agent
            .post('/api/auth/change-password')
            .set('x-csrf-token', v.csrf)
            .send({ currentPassword: 'Temp-Password-9876', newPassword: 'Viewer-Chosen-Pass-42' })
            .expect(204);
        await v.agent.get('/api/dashboard/status').expect(200);
    });

    it('a viewer can read but not act, and cannot reach admin APIs', async () => {
        const v = await login(t, 'vera', 'Viewer-Chosen-Pass-42');
        await v.agent.get('/api/dashboard/settings').expect(200);
        await v.agent.post('/api/dashboard/daily-stop/reset').set('x-csrf-token', v.csrf).expect(403);
        await v.agent.post('/api/dashboard/automate').set('x-csrf-token', v.csrf).send({ enabled: false }).expect(403);
        await v.agent.get('/api/users').expect(403);
        await v.agent.get('/api/audit').expect(403);
    });

    it('an operator can act but not manage users', async () => {
        await createUser(admin, 'otto', 'operator');
        const o = await login(t, 'otto', 'Temp-Password-9876');
        await o.agent
            .post('/api/auth/change-password')
            .set('x-csrf-token', o.csrf)
            .send({ currentPassword: 'Temp-Password-9876', newPassword: 'Operator-Pass-0042' })
            .expect(204);
        await o.agent.post('/api/dashboard/daily-stop/reset').set('x-csrf-token', o.csrf).expect(201);
        await o.agent.get('/api/users').expect(403);
    });

    it('disabling a user kills their live session immediately', async () => {
        const o = await login(t, 'otto', 'Operator-Pass-0042');
        const otto = (await admin.agent.get('/api/users').expect(200)).body.find(
            (u: { username: string }) => u.username === 'otto',
        );
        await admin.agent
            .patch(`/api/users/${otto.id}`)
            .set('x-csrf-token', admin.csrf)
            .send({ disabled: true })
            .expect(200);
        await o.agent.get('/api/dashboard/status').expect(401);
        await request(t.server)
            .post('/api/auth/login')
            .send({ username: 'otto', password: 'Operator-Pass-0042' })
            .expect(401);
    });

    it('the last admin can neither demote nor disable themselves', async () => {
        const me = (await admin.agent.get('/api/auth/me').expect(200)).body.user;
        await admin.agent
            .patch(`/api/users/${me.id}`)
            .set('x-csrf-token', admin.csrf)
            .send({ role: 'viewer' })
            .expect(400);
        await admin.agent
            .patch(`/api/users/${me.id}`)
            .set('x-csrf-token', admin.csrf)
            .send({ disabled: true })
            .expect(400);
    });

    it('duplicate usernames are refused', async () => {
        await admin.agent
            .post('/api/users')
            .set('x-csrf-token', admin.csrf)
            .send({ username: 'VERA', name: 'x', role: 'viewer', password: 'Another-Password-1' })
            .expect(409);
    });

    it('a password reset forces a change and signs the user out everywhere', async () => {
        const v = await login(t, 'vera', 'Viewer-Chosen-Pass-42');
        const vera = (await admin.agent.get('/api/users').expect(200)).body.find(
            (u: { username: string }) => u.username === 'vera',
        );
        await admin.agent
            .post(`/api/users/${vera.id}/reset-password`)
            .set('x-csrf-token', admin.csrf)
            .send({ password: 'Reset-By-Admin-777' })
            .expect(204);
        await v.agent.get('/api/auth/me').expect(401);
        const again = await login(t, 'vera', 'Reset-By-Admin-777');
        assert.equal(again.body.user.mustChangePassword, true);
    });

    it('lists own sessions and revokes the others', async () => {
        const a = await login(t, ADMIN.username, ADMIN.password);
        const b = await login(t, ADMIN.username, ADMIN.password);
        const list = (await a.agent.get('/api/auth/sessions').expect(200)).body;
        assert.ok(list.length >= 2);
        assert.equal(list.filter((s: { current: boolean }) => s.current).length, 1);
        await a.agent.post('/api/auth/sessions/revoke-others').set('x-csrf-token', a.csrf).expect(204);
        await b.agent.get('/api/auth/me').expect(401);
        await a.agent.get('/api/auth/me').expect(200);
        admin = a;
    });

    it('cannot revoke a session that belongs to someone else', async () => {
        await createUser(admin, 'sam', 'viewer');
        const sam = await login(t, 'sam', 'Temp-Password-9876');
        await sam.agent
            .post('/api/auth/change-password')
            .set('x-csrf-token', sam.csrf)
            .send({ currentPassword: 'Temp-Password-9876', newPassword: 'Viewer-Own-Pass-4242' })
            .expect(204);
        const samSessions = (await sam.agent.get('/api/auth/sessions').expect(200)).body as { id: string }[];
        assert.equal(samSessions.length, 1);
        const samSessionId = samSessions[0].id;

        await admin.agent.delete(`/api/auth/sessions/${samSessionId}`).set('x-csrf-token', admin.csrf).expect(404);
        await sam.agent.get('/api/auth/me').expect(200);
        // and the id really is revocable by its owner, so the 404 above was about ownership
        await sam.agent.delete(`/api/auth/sessions/${samSessionId}`).set('x-csrf-token', sam.csrf).expect(204);
        await sam.agent.get('/api/auth/me').expect(401);
    });
});

describe('the last active admin', () => {
    let a: { agent: Agent; csrf: string };
    before(async () => {
        await t.resetData();
        a = await login(t, ADMIN.username, ADMIN.password);
    });

    async function secondAdmin(username: string) {
        const created = await createUser(a, username, 'admin');
        const tmp = await login(t, username, 'Temp-Password-9876');
        await tmp.agent
            .post('/api/auth/change-password')
            .set('x-csrf-token', tmp.csrf)
            .send({ currentPassword: 'Temp-Password-9876', newPassword: 'Second-Admin-Pass-1' })
            .expect(204);
        return { ...tmp, id: created.id as string };
    }

    it('two admins demoting each other at the same moment still leave one admin', async () => {
        const me = (await a.agent.get('/api/auth/me').expect(200)).body.user;
        const b = await secondAdmin('adm2');
        const [r1, r2] = await Promise.all([
            a.agent.patch(`/api/users/${b.id}`).set('x-csrf-token', a.csrf).send({ role: 'viewer' }),
            b.agent.patch(`/api/users/${me.id}`).set('x-csrf-token', b.csrf).send({ role: 'viewer' }),
        ]);
        const statuses = [r1.status, r2.status];
        assert.ok(statuses.includes(400), `one demotion must be refused, got ${statuses.join(',')}`);
        assert.ok(
            statuses.every((s) => s === 200 || s === 400),
            statuses.join(','),
        );
        const admins = await t.collection('users').countDocuments({ role: 'admin', disabled: false });
        assert.ok(admins >= 1, `active admins left: ${admins}`);
    });

    it('the same holds for a demotion racing a disable', async () => {
        await t.resetData();
        a = await login(t, ADMIN.username, ADMIN.password);
        const me = (await a.agent.get('/api/auth/me').expect(200)).body.user;
        const b = await secondAdmin('adm3');
        const [r1, r2] = await Promise.all([
            a.agent.patch(`/api/users/${b.id}`).set('x-csrf-token', a.csrf).send({ disabled: true }),
            b.agent.patch(`/api/users/${me.id}`).set('x-csrf-token', b.csrf).send({ role: 'operator' }),
        ]);
        assert.ok([r1.status, r2.status].includes(400), `${r1.status},${r2.status}`);
        assert.ok((await t.collection('users').countDocuments({ role: 'admin', disabled: false })) >= 1);
    });
});

describe('audit log paging', () => {
    it('pages through rows that share one millisecond without skipping or repeating any', async () => {
        await t.resetData();
        const s = await login(t, ADMIN.username, ADMIN.password);
        const at = new Date(Date.now() - 60_000);
        await t.collection('audit_events').insertMany(
            Array.from({ length: 7 }, (_, i) => ({
                at,
                actorId: null,
                actorUsername: null,
                action: `test.same_ms_${i}`,
                target: null,
                ip: 'test',
                success: true,
                detail: null,
            })),
        );
        const seen: string[] = [];
        let before: string | null = null;
        for (let page = 0; page < 20; page++) {
            const q: string = `/api/audit?limit=3${before ? `&before=${encodeURIComponent(before)}` : ''}`;
            const res = await s.agent.get(q).expect(200);
            seen.push(...res.body.items.map((e: { id: string }) => e.id));
            before = res.body.nextBefore;
            if (!before) break;
            assert.match(before, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[0-9a-f]{24}$/);
        }
        const all = (await s.agent.get('/api/audit?limit=200').expect(200)).body.items.map((e: { id: string }) => e.id);
        assert.equal(new Set(seen).size, seen.length, 'no row twice');
        assert.deepEqual(seen, all, 'every row, in order');
        assert.ok(all.length >= 8);
    });

    it('still accepts a plain ISO date, and rejects junk', async () => {
        const s = await login(t, ADMIN.username, ADMIN.password);
        const future = new Date(Date.now() + 60_000).toISOString();
        const res = await s.agent.get(`/api/audit?before=${encodeURIComponent(future)}`).expect(200);
        assert.ok(res.body.items.length > 0);
        await s.agent.get('/api/audit?before=yesterday').expect(400);
        await s.agent.get(`/api/audit?before=${encodeURIComponent(`${future}_nothex`)}`).expect(400);
        await s.agent.get('/api/audit?before=2026-13-45T99:99:99Z').expect(400);
    });
});

describe('session lifetime', () => {
    before(async () => {
        await t.resetData();
    });

    it('expires after 2 h idle', async () => {
        const s = await login(t, ADMIN.username, ADMIN.password);
        const sessions = t.get<{ now: () => number }>('auth/sessions/session.service.js#SessionService');
        sessions.now = () => Date.now() + 2 * 3_600_000 + 1_000;
        await s.agent.get('/api/auth/me').expect(401);
        sessions.now = Date.now;
    });

    it('activity slides the idle window but never past 12 h', async () => {
        const s = await login(t, ADMIN.username, ADMIN.password);
        const sessions = t.get<{ now: () => number }>('auth/sessions/session.service.js#SessionService');
        const start = Date.now();
        for (let h = 1.5; h < 12; h += 1.5) {
            sessions.now = () => start + h * 3_600_000;
            await s.agent.get('/api/auth/me').expect(200);
        }
        sessions.now = () => start + 12 * 3_600_000 + 1_000;
        await s.agent.get('/api/auth/me').expect(401);
        sessions.now = Date.now;
    });
});
