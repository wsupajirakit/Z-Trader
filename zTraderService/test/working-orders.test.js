/**
 * The bot never stacks the same setup and never sends an order blind (3 Nov 2026 incident: the
 * scalp round re-sent GBPUSD BUY LIMIT @1.34176 five times, scalp + intraday both sent EURUSD
 * @1.1197, and all of them filled in the same second).
 *
 * Uses dist/ (no broker, no network, no Mongo). Run: npm run build:api && node --test test/working-orders.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Long = require('long');

const DIST = path.join(__dirname, '..', 'dist');
const { GoldAutomateService } = require(path.join(DIST, 'gold/gold-automate.service'));
const { OrderSkipped, DomainError } = require(path.join(DIST, 'gold/domain/domain-error'));
const { workingEntries, duplicateOf } = require(path.join(DIST, 'gold/domain/working-orders'));
const { INSTRUMENTS } = require(path.join(DIST, 'gold/domain/instruments'));

const GBP = INSTRUMENTS.GBPUSD;
const GBP_ID = 2;
const BUY_LIMIT = (entry) => ({
    order_type: 'BUY_LIMIT', entry, sl: entry - 0.0006, tp1: entry + 0.0015, tp2: null, rr_tp1: 2.5,
    confidence: 7, size: 'half', playbook_ref: 'scalp #1', invalidation: '', valid_until_utc: null,
    reason: 'r', analysis_summary: 's',
});
// shaped like a decoded ProtoOAReconcileRes: int64 fields arrive as Long objects
const pending = (orderId, price, clientOrderId, side = 1) => ({
    orderId: Long.fromNumber(orderId),
    limitPrice: price,
    clientOrderId,
    tradeData: { symbolId: Long.fromNumber(GBP_ID), tradeSide: side, volume: Long.fromNumber(20_000_000) },
});

function bot(reconcile, { cancelFails = false } = {}) {
    const o = Object.create(GoldAutomateService.prototype);
    const calls = { sent: [], cancelled: [] };
    o.logger = { log() {}, warn() {}, error() {}, debug() {} };
    o.ctraderService = {
        getPositions: async () => {
            if (reconcile instanceof Error) throw reconcile;
            return reconcile;
        },
        cancelOrder: async (id) => {
            if (cancelFails) throw new Error('TRADING_DISABLED');
            calls.cancelled.push(id);
        },
    };
    o.sizeOrder = () => ({ lots: 2 });
    o.scalpsToday = () => 0;
    o.scalpCount = new Map();
    o.ordersService = { createOrder: async () => null };
    o.engine = () => 'ta';
    o.tickSnapshot = () => null;
    o.activity = { push() {} };
    o.executionService = { executeOrder: async (params) => calls.sent.push(params) };
    return { o, calls };
}

test('the same setup already pending is not sent again, even without our clientOrderId', async () => {
    const { o, calls } = bot({ position: [], order: [pending(1, 1.34176, '')] });
    await assert.rejects(o.placeOrder('scalp', BUY_LIMIT(1.34176), null, GBP, GBP_ID), OrderSkipped);
    assert.equal(calls.sent.length, 0);
});

test('another mode holding the same price is the same setup (scalp vs intraday)', async () => {
    const { o, calls } = bot({ position: [], order: [pending(9, 1.11970, 'gold-intraday-abc')] });
    await assert.rejects(o.placeOrder('scalp', BUY_LIMIT(1.1197), null, GBP, GBP_ID), OrderSkipped);
    assert.equal(calls.sent.length, 0);
});

test('an open position at that price also blocks a repeat', async () => {
    const pos = { positionId: Long.fromNumber(5), price: 1.34176, tradeData: { symbolId: Long.fromNumber(GBP_ID), tradeSide: 1 } };
    const { o, calls } = bot({ position: [pos], order: [] });
    await assert.rejects(o.placeOrder('scalp', BUY_LIMIT(1.3418), null, GBP, GBP_ID), OrderSkipped);
    assert.equal(calls.sent.length, 0);
});

test('a new round replaces its own previous order (cancel, then send)', async () => {
    const { o, calls } = bot({ position: [], order: [pending(7, 1.34176, 'gold-scalp-old')] });
    await o.placeOrder('scalp', BUY_LIMIT(1.34176), null, GBP, GBP_ID);
    assert.deepEqual(calls.cancelled, [7]);
    assert.equal(calls.sent.length, 1);
});

test('fail closed: broker unreadable or cancel refused = no new order', async () => {
    const down = bot(new Error('timeout'));
    await assert.rejects(down.o.placeOrder('scalp', BUY_LIMIT(1.34), null, GBP, GBP_ID), DomainError);
    assert.equal(down.calls.sent.length, 0);
    const stuck = bot({ position: [], order: [pending(7, 1.34176, 'gold-scalp-old')] }, { cancelFails: true });
    await assert.rejects(stuck.o.placeOrder('scalp', BUY_LIMIT(1.34176), null, GBP, GBP_ID), DomainError);
    assert.equal(stuck.calls.sent.length, 0);
});

test('a different setup still goes out', async () => {
    const { o, calls } = bot({ position: [], order: [pending(1, 1.34176, '', 1), pending(2, 1.3420, '', 2)] });
    await o.placeOrder('scalp', BUY_LIMIT(1.3405), null, GBP, GBP_ID); // 12.6 pips away, and the SELL is the other side
    assert.equal(calls.sent.length, 1);
});

test('exposure unknown counts as full, never as zero', async () => {
    const { o } = bot(new Error('timeout'));
    o.instruments = { profileBySymbolId: () => GBP };
    const one = await o.getOpenPositions(GBP, GBP_ID);
    assert.ok(one.count >= Number.MAX_SAFE_INTEGER);
    assert.ok((await o.getOpenPositionsAllInstruments()) >= Number.MAX_SAFE_INTEGER);
});

test('helpers read Long ids and skip closing orders', () => {
    const rec = { order: [pending(3, 1.3, 'x'), { ...pending(4, 1.31, 'y'), closingOrder: true }], position: [] };
    const w = workingEntries(rec, GBP_ID);
    assert.deepEqual(w.map((e) => e.id), [3]);
    assert.equal(duplicateOf(w, 'BUY', 1.30025, 0.0003)?.id, 3);
    assert.equal(duplicateOf(w, 'SELL', 1.3, 0.0003), undefined);
});
