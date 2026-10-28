/** Login throttling and account lockout, at the production rate limit (10/min per IP), TRUST_PROXY=0. */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ADMIN, API_KEY, startApp, type TestApp } from './helpers/app.mts';

let t: TestApp;
before(async () => {
    t = await startApp({ LOGIN_RATE_LIMIT_PER_MIN: '10' });
});
after(async () => {
    await t.close();
});

const ghost = (i: number) => ({ username: `ghost${i}`, password: 'whatever-whatever' });

describe('brute force', () => {
    beforeEach(() => {
        t.resetThrottle();
    });

    it('locks the account after 5 failures, refuses even the right password with the same 401, and audits it', async () => {
        let failure: request.Response | undefined;
        for (let i = 0; i < 5; i++) {
            failure = await request(t.server)
                .post('/api/auth/login')
                .send({ username: ADMIN.username, password: `wrong-${i}-xxxxxx` })
                .expect(401);
        }
        // locked: indistinguishable from a wrong password (no 429, no retryAfterSec)
        const locked = await request(t.server).post('/api/auth/login').send(ADMIN).expect(401);
        assert.deepEqual(locked.body, failure!.body);

        // the lock expires on its own
        const auth = t.get<{ now: () => number }>('auth/auth.service.js#AuthService');
        auth.now = () => Date.now() + 16 * 60_000;
        try {
            await request(t.server).post('/api/auth/login').send(ADMIN).expect(200);
        } finally {
            auth.now = Date.now;
        }

        const agent = request.agent(t.server);
        await agent.post('/api/auth/login').send(ADMIN).expect(200);
        const audit = await agent.get('/api/audit?limit=200').expect(200);
        const actions = audit.body.items.map((e: { action: string }) => e.action);
        assert.ok(actions.includes('auth.login_failed'));
        assert.ok(actions.includes('auth.login_locked'));
        assert.ok(
            !JSON.stringify(audit.body).includes('wrong-0'),
            'attempted passwords must never reach the audit log',
        );
    });

    it('throttles login per IP: 10 a minute, then 429', async () => {
        for (let i = 0; i < 10; i++) await request(t.server).post('/api/auth/login').send(ghost(i)).expect(401);
        await request(t.server).post('/api/auth/login').send(ghost(10)).expect(429);
    });

    it('with TRUST_PROXY=0 X-Forwarded-For is ignored, so rotating it does not reset the budget', async () => {
        for (let i = 0; i < 10; i++) {
            await request(t.server)
                .post('/api/auth/login')
                .set('x-forwarded-for', `198.51.100.${i + 1}`)
                .send(ghost(i))
                .expect(401);
        }
        await request(t.server)
            .post('/api/auth/login')
            .set('x-forwarded-for', '198.51.100.200')
            .send(ghost(10))
            .expect(429);
    });
});

describe('machine verify throttle', () => {
    beforeEach(() => {
        t.resetThrottle();
    });

    const verify = (clientIp: string | undefined, i: number) =>
        request(t.server)
            .post('/api/v1/auth/verify')
            .set('x-api-key', API_KEY)
            .send({ ...ghost(i), ...(clientIp ? { clientIp } : {}) });

    it('is per end-user IP (the forwarded clientIp), not shared by every Actor user', async () => {
        for (let i = 0; i < 10; i++) await verify('203.0.113.10', i).expect(401);
        await verify('203.0.113.10', 10).expect(429);
        // another person signing in through the same Actor is not affected
        await verify('203.0.113.11', 11).expect(401);
        await request(t.server)
            .post('/api/v1/auth/verify')
            .set('x-api-key', API_KEY)
            .send({ ...ADMIN, clientIp: '203.0.113.12' })
            .expect(200);
    });

    it('without a clientIp it falls back to the socket peer', async () => {
        for (let i = 0; i < 10; i++) await verify(undefined, i).expect(401);
        await verify(undefined, 10).expect(429);
    });
});
