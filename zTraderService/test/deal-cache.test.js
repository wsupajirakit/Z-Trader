// Shared deal cache and the two guards built on it (daily stop P&L, loss cooldown).
const assert = require('node:assert/strict');
const test = require('node:test');
const { DealCacheService } = require('../dist/gold/records/deal-cache.service');
const { GoldAutomateService } = require('../dist/gold/gold-automate.service');

const deal = (symbolId, closedAt, grossCents) => ({
    symbolId,
    executionTimestamp: closedAt,
    moneyDigits: 2,
    closePositionDetail: { grossProfit: grossCents, commission: -50, swap: 0 },
});

function cacheWith(fetch) {
    let calls = 0;
    const svc = new DealCacheService({
        getDealList: async (...a) => {
            calls++;
            return fetch(...a);
        },
    });
    return { svc, calls: () => calls };
}

test('one cTrader read serves every guard and instrument within the TTL; executions invalidate it', async () => {
    const now = Date.now();
    const { svc, calls } = cacheWith(() => ({
        deal: [deal(41, now - 1000, -2000), deal(1, now - 2000, 5000), { executionTimestamp: now }],
    }));
    const [a, b, c] = await Promise.all([svc.closedSince(0), svc.closedSince(0), svc.closedSince(now - 1500)]);
    assert.equal(calls(), 1);
    assert.equal(a.deals.length, 2, 'opening deals (no closePositionDetail) are ignored');
    assert.deepEqual(
        a.deals.map((d) => d.netUsd),
        [-20.5, 49.5],
    );
    assert.equal(c.deals.length, 1, 'filtered by close time');
    assert.equal(b.stale, false);
    svc.onExecution();
    await svc.closedSince(0);
    assert.equal(calls(), 2);
});

function automate(deals) {
    const o = Object.create(GoldAutomateService.prototype);
    o.deals = deals;
    o.logger = { warn() {}, log() {} };
    o.activity = { push() {} };
    o.dailyStopReset = null;
    return o;
}

test('loss cooldown: last losing close per symbol; unknown when the deal list cannot be read', async () => {
    const now = Date.now();
    const ok = automate({
        closedSince: async () => ({
            deals: [
                { symbolId: 41, closedAt: now - 5000, netUsd: -10 },
                { symbolId: 41, closedAt: now - 1000, netUsd: 15 },
                { symbolId: 1, closedAt: now - 500, netUsd: -3 },
            ],
            stale: false,
            ageMs: 0,
        }),
    });
    assert.equal(await ok.getLastLossCloseTs(41), now - 5000);
    assert.equal(await ok.getLastLossCloseTs(4), null);
    const down = automate({ closedSince: async () => Promise.reject(new Error('rate limited')) });
    assert.equal(await down.getLastLossCloseTs(41), undefined, 'must not read as "no recent loss"');
});

test('daily P&L: sums the day, warns on a stale copy, null when unreadable', async () => {
    const pushed = [];
    const o = automate({
        closedSince: async () => ({ deals: [{ netUsd: -12.5 }, { netUsd: 2.5 }], stale: true, ageMs: 120_000 }),
    });
    o.activity = { push: (lvl, msg) => pushed.push([lvl, msg]) };
    assert.equal(await o.getTodayPnl(), -10);
    assert.match(pushed[0][1], /unavailable — using P&L -10.00 USD from 2 min ago/);
    const down = automate({ closedSince: async () => Promise.reject(new Error('down')) });
    assert.equal(await down.getTodayPnl(), null);
});
