/**
 * The System log says plainly when the bot may not trade and when it may again, instead of counting
 * down to rounds that will only be skipped (3 Nov 2026: 20:00–21:00 BKK news blackout looked like
 * "in 2:30 min" on every scalp/intraday row).
 *
 * Uses dist/ (no broker, no network). Run: npm run build:api && node --test test/session-gate.test.js
 * Dates are November 2026, New York on EST (UTC−5), Bangkok UTC+7.
 * Windows since 10 Nov 2026: scalp 02:00–05:00 ET (London open only), intraday 02:30–07:00 ET.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const gate = require(path.join(DIST, 'gold/domain/session-gate'));
const { INSTRUMENTS } = require(path.join(DIST, 'gold/domain/instruments'));
const { GoldAutomateService } = require(path.join(DIST, 'gold/gold-automate.service'));

const { XAUUSD: XAU, EURUSD: EUR, USDJPY: JPY } = INSTRUMENTS;
const at = (iso) => new Date(iso);
const g = (mode, p, iso) => gate.sessionGate(mode, p.session, p.hours, at(iso));

test('news blackout: closed now, resumes with the next session window', () => {
    const r = g('scalp', EUR, '2026-11-10T13:30:00Z'); // Tue 08:30 ET
    assert.match(r.reason, /news blackout/);
    // the blackout ends 09:00 ET but the scalp window is London only, so Wednesday 02:00 ET
    assert.equal(r.resumesAt.toISOString(), '2026-11-11T07:00:00.000Z');
    assert.equal(gate.fmtResume(r.resumesAt, at('2026-11-10T13:30:00Z')), 'Wed 14:00 BKK / Wed 02:00 ET (in 17 h 30 min)');
    const gbp = g('scalp', INSTRUMENTS.GBPUSD, '2026-11-10T07:10:00Z'); // Tue 02:10 ET, UK data
    assert.match(gbp.reason, /news blackout 02:00-02:30 ET/);
    assert.equal(gbp.resumesAt.toISOString(), '2026-11-10T07:30:00.000Z');
});

test('outside the scalp window: resumes at the next window, next day', () => {
    const r = g('scalp', XAU, '2026-11-10T18:00:00Z'); // Tue 13:00 ET
    assert.match(r.reason, /outside the scalp window \(02:00-05:00 ET\)/);
    assert.equal(r.resumesAt.toISOString(), '2026-11-11T07:00:00.000Z'); // Wed 02:00 ET
    // 13:00 ET Tuesday is already 01:00 Wednesday in Bangkok, so no weekday is printed
    assert.equal(gate.fmtBkk(r.resumesAt, at('2026-11-10T18:00:00Z')), '14:00 BKK');
    assert.equal(gate.fmtBkk(r.resumesAt, at('2026-11-10T16:00:00Z')), 'Wed 14:00 BKK'); // 23:00 BKK Tuesday
    assert.equal(g('scalp', XAU, '2026-11-10T07:00:00Z'), null); // Tue 02:00 ET: London open, allowed
    assert.match(g('scalp', XAU, '2026-11-10T13:30:00Z').reason, /news blackout/); // 08:30 ET: the US-data blackout comes first
    assert.equal(g('scalp', XAU, '2026-11-10T14:30:00Z').reason, 'outside the scalp window (02:00-05:00 ET)'); // 09:30 ET: no NY window any more
});

test('Friday cutoff waits through the weekend for an open market and a session window', () => {
    const fri = '2026-11-13T18:00:00Z'; // Fri 13:00 ET
    const xau = g('scalp', XAU, fri);
    assert.match(xau.reason, /Friday afternoon/);
    assert.equal(xau.resumesAt.toISOString(), '2026-11-16T07:00:00.000Z'); // Mon 02:00 ET
    const jpy = g('scalp', JPY, fri);
    assert.equal(jpy.resumesAt.toISOString(), '2026-11-16T00:00:00.000Z'); // Sun 19:00 ET, Tokyo window
    assert.match(gate.fmtResume(jpy.resumesAt, at(fri)), /^Mon 07:00 BKK \/ Sun 19:00 ET \(in 2 d 6 h\)$/);
});

test('swing and position are never gated; an open window is null', () => {
    assert.equal(g('swing', EUR, '2026-11-10T13:30:00Z'), null);
    assert.equal(g('position', XAU, '2026-11-10T13:30:00Z'), null);
    assert.equal(g('intraday', XAU, '2026-11-10T11:59:00Z'), null); // 06:59 ET
    assert.equal(g('intraday', XAU, '2026-11-10T12:00:00Z').reason, 'outside the intraday window (02:30–07:00 ET)'); // 07:00 ET
});

test('helpers: kind without clock times, modes grouped per instrument', () => {
    assert.equal(gate.gateKind('news blackout 08:00-09:00 ET (US data 08:30)'), 'news blackout');
    assert.equal(gate.gateKind('outside the scalp window (02:00-05:00 ET)'), 'outside the scalp window');
    const items = [
        { inst: 'XAUUSD', mode: 'scalp' },
        { inst: 'EURUSD', mode: 'scalp' },
        { inst: 'XAUUSD', mode: 'intraday' },
    ];
    assert.equal(gate.joinModes(items, true), 'XAUUSD scalp+intraday, EURUSD scalp');
    assert.equal(gate.joinModes(items.slice(0, 1), false), 'scalp');
});

function bot(instruments, mode = 'intraday') {
    const o = Object.create(GoldAutomateService.prototype);
    const lines = [];
    o.gates = new Map();
    o.activity = { push: (level, message, tag) => lines.push({ level, message, tag }) };
    o.enabledInstruments = () => instruments;
    // one tick's gate work for the mode on every instrument, as tick() does it
    const tick = (iso) => {
        const now = at(iso);
        const et = require(path.join(DIST, 'gold/domain/market-hours')).etParts(now);
        const closed = [];
        const opened = [];
        const noTrade = [];
        for (const p of instruments) {
            const gt = o.trackGate(mode, p, et, now, closed, opened);
            if (gt) noTrade.push({ inst: p.key, mode, gate: gt });
        }
        o.logGateChanges(closed, opened, now);
        return o.noTradeSummary(noTrade, now);
    };
    return { o, lines, tick };
}

test('System log: one NO TRADING line when the gate shuts, one TRADING OPEN line when it opens', () => {
    const { lines, tick } = bot([XAU, EUR], 'scalp');
    assert.deepEqual(tick('2026-11-10T09:55:00Z'), []); // 04:55 ET, London window open
    assert.equal(lines.length, 0);

    const hb = tick('2026-11-10T10:00:00Z'); // 05:00 ET: the scalp window closes until Wednesday
    assert.equal(lines.length, 1, 'XAU and EUR share the same label, so one line');
    assert.equal(lines[0].level, 'warn');
    assert.equal(
        lines[0].message,
        '⏸ NO TRADING — outside the scalp window (02:00-05:00 ET) · trading resumes Wed 14:00 BKK / Wed 02:00 ET (in 21 h 00 min)',
    );
    assert.equal(lines[0].tag, 'XAUUSD scalp, EURUSD scalp');
    assert.deepEqual(hb, ['⏸ NO TRADING until Wed 14:00 BKK (outside the scalp window): XAUUSD scalp, EURUSD scalp']);

    tick('2026-11-10T11:30:00Z'); // 06:30 ET: still shut for the same reason: nothing new
    assert.equal(lines.length, 1);
    tick('2026-11-10T13:30:00Z'); // 08:30 ET: the reason changes to the US-data blackout, which is reported (two labels: EUR adds ECB)
    assert.equal(lines.length, 3);
    assert.match(lines[1].message, /^⏸ NO TRADING — news blackout 08:00-09:00 ET/);

    assert.deepEqual(tick('2026-11-11T07:00:00Z'), []); // Wed 02:00 ET
    assert.equal(lines.length, 4);
    assert.deepEqual(lines[3], {
        level: 'ok',
        message: '▶ TRADING OPEN — new orders allowed again',
        tag: 'XAUUSD scalp, EURUSD scalp',
    });
});

test('after the loop restarts, a gate that is already shut is reported again', () => {
    const { o, lines, tick } = bot([XAU]);
    tick('2026-11-10T13:10:00Z');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].tag, 'intraday'); // one instrument: mode only
    tick('2026-11-10T13:15:00Z');
    assert.equal(lines.length, 1);
    o.gates.clear(); // what tick() does while the loop is off
    tick('2026-11-10T13:20:00Z');
    assert.equal(lines.length, 2);
});
