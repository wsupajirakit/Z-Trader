/**
 * Dashboard -> zTraderActor bridge without ACTOR_URL: reads say why the Actor panel is empty (200),
 * writes answer 503 and are still audited. Separate file because ConfigModule reads the environment
 * once per process (see helpers/app.mts).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ADMIN, startApp, type TestApp } from './helpers/app.mts';

let t: TestApp;
before(async () => {
    // empty = unset (and overrides an ACTOR_URL that may be exported in the developer's shell)
    t = await startApp({ ACTOR_URL: '' });
});
after(async () => {
    await t.close();
});

describe('actor bridge with ACTOR_URL unset', () => {
    let agent: ReturnType<typeof request.agent>;
    let csrf: string;
    before(async () => {
        await t.resetData();
        agent = request.agent(t.server);
        csrf = (await agent.post('/api/auth/login').send(ADMIN).expect(200)).body.csrfToken as string;
    });

    it('state and logs report available:false with the reason', async () => {
        const expected = { available: false, reason: 'ACTOR_URL is not configured' };
        assert.deepEqual((await agent.get('/api/actor/state').expect(200)).body, expected);
        assert.deepEqual((await agent.get('/api/actor/logs').expect(200)).body, expected);
    });

    it('start/stop answer 503 and are audited as failures', async () => {
        const res = await agent
            .post('/api/actor/start')
            .set('x-csrf-token', csrf)
            .send({ symbols: ['XAUUSD'], mode: 'sonic' })
            .expect(503);
        assert.equal(res.body.error, 'ACTOR_URL is not configured');
        await agent.post('/api/actor/stop').set('x-csrf-token', csrf).expect(503);
        const items = (await t.get<any>('audit/audit.service.js#AuditService').list(50)).items as Array<
            Record<string, any>
        >;
        const start = items.find((e) => e.action === 'actor.start');
        assert.ok(start);
        assert.equal(start.success, false);
        assert.equal(start.detail.error, 'ACTOR_URL is not configured');
    });
});
