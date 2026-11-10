/**
 * The Asian-range break (scalp #2 / intraday #2) enters WITH the break: a STOP past the closing
 * bar, SL beyond the broken edge. Never a LIMIT back at the edge — on 60 trading days of 5m bars
 * that order reached its target 0–9% of the time (it fills on the breakouts that fail and misses
 * the ones that run). RVOL on the intraday break bar adds confidence and no longer vetoes.
 *
 * Uses dist/ (no broker, no network): npm run build:api && node --test test/breakout-ta.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const { GoldTaService } = require(path.join(DIST, 'gold/analysis/gold-ta.service'));
const { enrich } = require(path.join(DIST, 'gold/domain/indicators'));
const { INSTRUMENTS } = require(path.join(DIST, 'gold/domain/instruments'));

const XAU = INSTRUMENTS.XAUUSD;
const quiet = { log() {}, warn() {}, error() {}, debug() {} };
const ta = () => {
    const t = new GoldTaService();
    t.logger = quiet;
    return t;
};

// Wednesday 11 Nov 2026 08:30 UTC = 03:30 ET: inside the London window, Asian range (23:00–07:00 UTC) complete
const NOW = Date.UTC(2026, 10, 11, 8, 30);
const ASIA_START = Date.UTC(2026, 10, 10, 23, 0);
const ASIA_END = Date.UTC(2026, 10, 11, 7, 0);
const withNow = (fn) => {
    const real = Date.now;
    Date.now = () => NOW;
    try {
        return fn();
    } finally {
        Date.now = real;
    }
};

/** bars of `ms` period ending with a CLOSED bar at NOW - ms; `shape(ts, i)` gives the close */
function series(ms, n, shape, volume = () => 100) {
    const bars = [];
    for (let i = 0; i < n; i++) {
        const ts = NOW - (n - i) * ms;
        const c = shape(ts, i);
        const span = ms === 300_000 ? 1.0 : ms === 900_000 ? 0.6 : 3.0; // 5m / 15m / 1h bar height
        bars.push({ ts, open: c - span * 0.8, high: c, low: c - span, close: c, volume: volume(ts, i) });
    }
    return enrich(bars);
}

const inAsia = (ts) => ts >= ASIA_START && ts < ASIA_END;
const asianRange = (bars) => {
    const win = bars.filter((b) => inAsia(b.ts));
    return { hi: Math.max(...win.map((b) => b.high)), lo: Math.min(...win.map((b) => b.low)) };
};

/** 5m bars: quiet overnight oscillation, then from 07:05 UTC a steady climb that ends `endAbove` above the range high */
function scalpBars(endAbove) {
    const n = 500;
    const quiet = (i) => 4005 + 4.5 * Math.sin(i / 3);
    const tsOf = (i) => NOW - (n - i) * 300_000;
    let rH = -Infinity;
    for (let i = 0; i < n; i++) if (inAsia(tsOf(i))) rH = Math.max(rH, quiet(i)); // high = close in series()
    const post = []; // indices after the Asian window
    for (let i = 0; i < n; i++) if (tsOf(i) >= ASIA_END) post.push(i);
    const m5 = series(300_000, n, (ts, i) => {
        if (ts < ASIA_END) return quiet(i);
        const k = post.indexOf(i) + 1; // 1..post.length
        return rH - 3 + ((3 + endAbove) * k) / post.length; // last closed bar = rH + endAbove
    });
    return { m5, rH };
}

test('scalp #2: a 5m close just past the Asian high with the 15m trend up → BUY STOP past the close, SL under the edge', () => {
    // ATR(5m) ≈ 1 (bar height 1.0), so +0.5 above the range high is inside the 0.75×ATR cap
    const { m5, rH } = scalpBars(0.5);
    assert.ok(Math.abs(asianRange(m5).hi - rH) < 1e-9);
    const lastClose = m5[m5.length - 1].close;
    assert.ok(lastClose > rH + 0.1 && lastClose < rH + 0.75, `close ${lastClose} vs range high ${rH}`);
    const m15 = series(900_000, 400, (ts, i) => 3900 + (110 * i) / 400); // uptrend: EMA20 > EMA50

    const d = withNow(() =>
        ta().analyze('scalp', { xauusd_5m: m5, xauusd_15m: m15 }, { rrMin: 1.5, sizeCap: null, profile: XAU }),
    );
    assert.equal(d.order_type, 'BUY_STOP', d.reason);
    assert.equal(d.playbook_ref, 'scalp #2');
    assert.ok(d.entry > lastClose, `STOP ${d.entry} must sit past the close ${lastClose}`);
    assert.ok(d.sl < rH, `SL ${d.sl} must sit beyond the broken edge ${rH}`);
    assert.ok(Math.abs(rH - d.sl - 1.4 * m5[m5.length - 1].atr14) < 0.05, 'SL = edge − 1.4×ATR(5m)');
    assert.ok(d.rr_tp1 >= 1.5);
    assert.match(d.reason, /BUY STOP with the break \(scalp #2\)/);
    assert.ok(Math.abs(Date.parse(d.valid_until_utc) - (NOW + 2 * 3_600_000)) < 1000, 'valid for the London window');
});

test('scalp #2: a close that has already run past the edge is not chased; a close inside the range is no trade', () => {
    const m15 = series(900_000, 400, (ts, i) => 3900 + (110 * i) / 400);
    const far = scalpBars(1.0).m5; // 1.0 above with ATR ≈ 1 → past the 0.75×ATR cap
    const d1 = withNow(() => ta().analyze('scalp', { xauusd_5m: far, xauusd_15m: m15 }, { rrMin: 1.5, sizeCap: null, profile: XAU }));
    assert.equal(d1.order_type, 'NO_TRADE');
    const inside = series(300_000, 500, (ts, i) => 4005 + 4.5 * Math.sin(i / 3));
    const d2 = withNow(() => ta().analyze('scalp', { xauusd_5m: inside, xauusd_15m: m15 }, { rrMin: 1.5, sizeCap: null, profile: XAU }));
    assert.equal(d2.order_type, 'NO_TRADE');
});

function intradaySeries(breakVolume) {
    // 15m: overnight oscillation ±1.0 (range ≈ 2.6 > 0.5×ATR(1h) of 3), then the 08:00 and 08:15 UTC bars close above the range high
    const n = 400;
    const quiet = (i) => 4003.2 + 1.0 * Math.sin(i / 2);
    const tsOf = (i) => NOW - (n - i) * 900_000;
    let rH = -Infinity;
    for (let i = 0; i < n; i++) if (inAsia(tsOf(i))) rH = Math.max(rH, quiet(i));
    const m15 = series(
        900_000,
        n,
        (ts, i) => {
            if (ts < ASIA_END) return quiet(i);
            const k = Math.round((ts - ASIA_END) / 900_000); // 0..5 after 07:00 UTC
            return k >= 4 ? rH + 0.6 + 0.2 * (k - 4) : rH - 1.2;
        },
        (ts) => (ts >= ASIA_END + 4 * 900_000 ? breakVolume : 100),
    );
    const h1 = series(3_600_000, 400, (ts, i) => 3800 + (200 * i) / 400); // uptrend, EMA20>EMA50, above EMA200
    return { xauusd_15m: m15, xauusd_30m: m15, xauusd_1h: h1 };
}

test('intraday #2: a 15m close outside the Asian range → STOP with the break; RVOL adds confidence, never vetoes', () => {
    const quietVol = intradaySeries(100);
    const loud = intradaySeries(300);
    const rH = asianRange(quietVol.xauusd_15m).hi;
    const a = withNow(() => ta().analyze('intraday', quietVol, { rrMin: 1.8, sizeCap: null, profile: XAU }));
    const b = withNow(() => ta().analyze('intraday', loud, { rrMin: 1.8, sizeCap: null, profile: XAU }));
    for (const d of [a, b]) {
        assert.equal(d.order_type, 'BUY_STOP', d.reason);
        assert.equal(d.playbook_ref, 'intraday #2');
        assert.ok(d.entry > quietVol.xauusd_15m[quietVol.xauusd_15m.length - 1].close, 'STOP past the last close');
        assert.ok(d.sl < rH, `SL ${d.sl} beyond the broken edge ${rH}`);
        assert.ok(d.rr_tp1 >= 1.8);
        assert.doesNotMatch(d.reason, /RVOL .* < 1\.2/);
    }
    assert.equal(b.confidence, a.confidence + 1, 'RVOL ≥ 1.2 on the break bar adds one point');
    assert.match(b.reason, /RVOL ≥ 1\.2 confirms/);
});
