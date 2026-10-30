// Rate-limit protection for cTrader historical requests: spacing, backoff retry, shared deal cache.
const assert = require('node:assert/strict');
const test = require('node:test');
const { RequestLimiter, retryOnRateLimit, isRateLimited, backoffDelay } = require('../dist/ctrader/history-limiter');
const { SingleFlightCache } = require('../dist/common/utils/single-flight-cache');

test('limiter starts tasks at least minInterval apart, in call order', async () => {
    let t = 0;
    const starts = [];
    const lim = new RequestLimiter(
        100,
        () => t,
        (ms) => {
            const at = t + ms;
            // wake sleepers in time order, one macrotask each, so every task sees its own clock
            return new Promise((r) =>
                setTimeout(() => {
                    t = Math.max(t, at);
                    r();
                }, ms / 10),
            );
        },
    );
    await Promise.all(
        [1, 2, 3, 4].map((i) =>
            lim.schedule(async () => {
                starts.push([i, t]);
            }),
        ),
    );
    assert.deepEqual(starts, [
        [1, 0],
        [2, 100],
        [3, 200],
        [4, 300],
    ]);
});

test('rate-limit errors are recognised in the shapes cTrader uses', () => {
    assert.ok(isRateLimited({ errorCode: 'REQUEST_FREQUENCY_EXCEEDED' }));
    assert.ok(isRateLimited({ description: 'You are being rate limited' }));
    assert.ok(isRateLimited(new Error('You are being rate limited')));
    assert.ok(!isRateLimited(new Error('timeout')));
    assert.ok(!isRateLimited(null));
});

test('backoff grows and stays within jitter bounds', () => {
    assert.equal(
        backoffDelay(0, () => 0.5),
        500,
    );
    assert.equal(
        backoffDelay(1, () => 0.5),
        1000,
    );
    assert.equal(
        backoffDelay(10, () => 1),
        10_000,
    );
    assert.ok(backoffDelay(2, () => 0) >= 1500);
});

test('retry waits and succeeds; other errors and exhausted retries propagate', async () => {
    const waits = [];
    let n = 0;
    const ok = await retryOnRateLimit(
        async () => {
            if (++n < 3) throw { errorCode: 'REQUEST_FREQUENCY_EXCEEDED' };
            return 'done';
        },
        {
            sleep: async (ms) => {
                waits.push(ms);
            },
            random: () => 0.5,
        },
    );
    assert.equal(ok, 'done');
    assert.deepEqual(waits, [500, 1000]);
    await assert.rejects(
        retryOnRateLimit(
            async () => {
                throw new Error('boom');
            },
            { sleep: async () => {} },
        ),
        /boom/,
    );
    let calls = 0;
    await assert.rejects(
        retryOnRateLimit(
            async () => {
                calls++;
                throw { description: 'rate limit' };
            },
            { retries: 2, sleep: async () => {} },
        ),
    );
    assert.equal(calls, 3);
});

test('cache: concurrent callers share one load, TTL respected, stale served on failure', async () => {
    let t = 0;
    let loads = 0;
    let fail = false;
    const c = new SingleFlightCache(
        async () => {
            loads++;
            await Promise.resolve();
            if (fail) throw new Error('down');
            return loads;
        },
        1000,
        5000,
        () => t,
    );
    const [a, b, d] = await Promise.all([c.get(), c.get(), c.get()]);
    assert.equal(loads, 1);
    assert.deepEqual([a.data, b.data, d.data], [1, 1, 1]);
    t = 500;
    assert.equal((await c.get()).data, 1);
    assert.equal(loads, 1);
    t = 1500;
    fail = true;
    const s = await c.get();
    assert.equal(s.stale, true);
    assert.equal(s.data, 1);
    t = 9000;
    await assert.rejects(c.get(), /down/);
    c.invalidate();
    fail = false;
    assert.equal((await c.get()).data, loads);
});
