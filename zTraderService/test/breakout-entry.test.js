/**
 * placeOrder for "enter with the break" STOP entries:
 *   - the market still below the level → a STOP order with an expiry
 *   - the market already through the level by a little → sent at market (a STOP on the wrong side
 *     of the market is rejected by the broker)
 *   - the market more than 25% of the SL distance past the level → skipped, not chased
 *   - one breakout trade (playbook "#2") per side per instrument per day; other playbooks are not limited
 *
 * Uses dist/ (no broker, no network): npm run build:api && node --test test/breakout-entry.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const { GoldAutomateService } = require(path.join(DIST, 'gold/gold-automate.service'));
const { INSTRUMENTS } = require(path.join(DIST, 'gold/domain/instruments'));
const { OrderSkipped } = require(path.join(DIST, 'gold/domain/domain-error'));

const EUR = INSTRUMENTS.EURUSD;
const quiet = { log() {}, warn() {}, error() {}, debug() {} };

function bot({ tick, tickAgeMs = 0, positions = [], orders = [] } = {}) {
    const o = Object.create(GoldAutomateService.prototype);
    o.logger = quiet;
    o.overrides = new Map();
    o.configService = { get: (k, d) => d };
    o.ticks = new Map();
    if (tick) o.ticks.set(EUR.key, { ...tick, at: Date.now() - tickAgeMs });
    o.scalpCount = new Map();
    o.breakoutDone = new Map();
    o.instruments = { active: EUR };
    o.activity = { push() {} };
    o.engine = () => 'ta';
    const sent = [];
    const created = [];
    const cancelled = [];
    o.ctraderService = {
        getPositions: async () => ({ position: positions, order: orders }),
        cancelOrder: async (id) => cancelled.push(id),
    };
    o.ordersService = { createOrder: async (doc) => created.push(doc) };
    o.executionService = { executeOrder: async (params) => sent.push(params) };
    return { o, sent, created, cancelled };
}

const decision = (over = {}) => ({
    order_type: 'BUY_STOP',
    entry: 1.101,
    sl: 1.1,
    tp1: 1.1025,
    tp2: 1.1035,
    rr_tp1: 1.5,
    confidence: 7,
    size: 'half',
    valid_until_utc: new Date(Date.now() + 3_600_000).toISOString(),
    invalidation: '',
    playbook_ref: 'scalp #2',
    reason: 'test',
    analysis_summary: '',
    ...over,
});

test('market below the STOP level: a STOP order at the level, with its expiry', async () => {
    const { o, sent } = bot({ tick: { bid: 1.1, ask: 1.1002 } });
    const uuid = await o.placeOrder('scalp', decision(), null, EUR, 1);
    assert.match(uuid, /^gold-scalp-/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].orderType, 'STOP');
    assert.equal(sent[0].price, 1.101);
    assert.equal(sent[0].side, 'BUY');
    assert.ok(sent[0].expirationTimestamp > Date.now());
});

test('market a little past the STOP level: sent at market, no expiry on a market order', async () => {
    const { o, sent, created } = bot({ tick: { bid: 1.1011, ask: 1.1012 } }); // 0.0002 past, SL distance 0.001
    await o.placeOrder('scalp', decision(), null, EUR, 1);
    assert.equal(sent[0].orderType, 'MARKET');
    assert.equal(sent[0].price, 1.1012);
    assert.equal(sent[0].expirationTimestamp, undefined);
    assert.equal(created[0].orderType, 'MARKET');
    assert.equal(created[0].price, 1.1012);
});

test('market more than 25% of the SL distance past the level: skipped, not chased', async () => {
    const { o, sent } = bot({ tick: { bid: 1.1013, ask: 1.1014 } }); // 0.0004 past > 0.00025
    await assert.rejects(o.placeOrder('scalp', decision(), null, EUR, 1), (e) => e instanceof OrderSkipped && /not chasing/.test(e.message));
    assert.equal(sent.length, 0);
});

test('a stale tick cannot vouch for the market: the STOP goes out as a STOP', async () => {
    const { o, sent } = bot({ tick: { bid: 1.1011, ask: 1.1012 }, tickAgeMs: 10 * 60_000 });
    await o.placeOrder('scalp', decision(), null, EUR, 1);
    assert.equal(sent[0].orderType, 'STOP');
});

test('a SELL STOP mirrors it: bid through the level → market', async () => {
    const { o, sent } = bot({ tick: { bid: 1.0988, ask: 1.0989 } });
    await o.placeOrder('scalp', decision({ order_type: 'SELL_STOP', entry: 1.099, sl: 1.1, tp1: 1.0975 }), null, EUR, 1);
    assert.equal(sent[0].orderType, 'MARKET');
    assert.equal(sent[0].price, 1.0988);
    assert.equal(sent[0].side, 'SELL');
});

test('one breakout trade per side per day; the other side and other playbooks are not limited', async () => {
    const { o, sent, cancelled } = bot({ tick: { bid: 1.1, ask: 1.1002 } });
    await o.placeOrder('scalp', decision(), null, EUR, 1);
    await assert.rejects(
        o.placeOrder('scalp', decision({ entry: 1.1015, sl: 1.1005, tp1: 1.103 }), null, EUR, 1),
        (e) => e instanceof OrderSkipped && /already placed on the BUY side today/.test(e.message),
    );
    assert.equal(sent.length, 1, 'nothing new went out');
    assert.equal(cancelled.length, 0, 'the working order was left alone');
    // the SELL side is a different trade
    await o.placeOrder('scalp', decision({ order_type: 'SELL_STOP', entry: 1.099, sl: 1.1, tp1: 1.0975 }), null, EUR, 1);
    assert.equal(sent.length, 2);
    // intraday #2 has its own count; scalp #1 (sweep) is not a breakout trade
    await o.placeOrder('intraday', decision({ playbook_ref: 'intraday #2' }), null, EUR, 1);
    await o.placeOrder('scalp', decision({ playbook_ref: 'scalp #1', order_type: 'BUY_LIMIT', entry: 1.0995 }), null, EUR, 1);
    await o.placeOrder('scalp', decision({ playbook_ref: 'scalp #1', order_type: 'BUY_LIMIT', entry: 1.0995 }), null, EUR, 1);
    assert.equal(sent.length, 5);
});

test('a LIMIT entry is untouched by the market check', async () => {
    const { o, sent } = bot({ tick: { bid: 1.1, ask: 1.1002 } });
    await o.placeOrder('swing', decision({ playbook_ref: 'swing #1', order_type: 'BUY_LIMIT', entry: 1.0995 }), null, EUR, 1);
    assert.equal(sent[0].orderType, 'LIMIT');
    assert.equal(sent[0].price, 1.0995);
});
