/** TRUST_PROXY=1 (Coolify/Traefik in front): cookie naming and client address come from the proxy. */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ADMIN, startApp, type TestApp } from './helpers/app.mts';

let t: TestApp;
before(async () => {
    t = await startApp({ TRUST_PROXY: '1', LOGIN_RATE_LIMIT_PER_MIN: '10' });
});
after(async () => {
    await t.close();
});
beforeEach(() => {
    t.resetThrottle();
});

/** what our single trusted proxy writes: whatever the client sent, then the address it saw */
const via = (clientSent: string | null, proxySaw: string) => (clientSent ? `${clientSent}, ${proxySaw}` : proxySaw);

describe('https behind a proxy', () => {
    it('uses the __Host- cookie with Secure when the proxy says https', async () => {
        const res = await request(t.server)
            .post('/api/auth/login')
            .set('x-forwarded-proto', 'https')
            .send(ADMIN)
            .expect(200);
        const cookie = String(res.headers['set-cookie']);
        assert.match(cookie, /^__Host-zt_session=/);
        assert.match(cookie, /Secure/);
    });

    it('over https only the __Host- cookie is read, never the plain name', async () => {
        const res = await request(t.server)
            .post('/api/auth/login')
            .set('x-forwarded-proto', 'https')
            .send(ADMIN)
            .expect(200);
        const token = /^__Host-zt_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1];
        const me = (cookie: string) =>
            request(t.server).get('/api/auth/me').set('x-forwarded-proto', 'https').set('Cookie', cookie);
        await me(`__Host-zt_session=${token}`).expect(200);
        // the same valid token under the plain name (as a sibling subdomain or plain-http page could plant it)
        await me(`zt_session=${token}`).expect(401);
    });
});

describe('client address behind one trusted proxy', () => {
    const attempt = (xff: string, i: number) =>
        request(t.server)
            .post('/api/auth/login')
            .set('x-forwarded-for', xff)
            .send({ username: `ghost${i}`, password: 'whatever-whatever' });

    it('an extra X-Forwarded-For hop sent by the client cannot rotate the login throttle key', async () => {
        for (let i = 0; i < 10; i++) await attempt(via(`10.0.${i}.1`, '203.0.113.50'), i).expect(401);
        // a fresh fake left-hand hop does not help: the right-most hop (written by our proxy) is the key
        await attempt(via('10.9.9.9', '203.0.113.50'), 10).expect(429);
        await attempt(via(null, '203.0.113.50'), 11).expect(429);
        // a different client, as seen by the proxy, has its own budget
        await attempt(via('10.0.0.1', '203.0.113.51'), 12).expect(401);
    });
});
