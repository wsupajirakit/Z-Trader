/**
 * The System log says plainly when the bot may not trade and when it may again, instead of counting
 * down to rounds that will only be skipped (3 Nov 2026: 20:00–21:00 BKK news blackout looked like
 * "in 2:30 min" on every scalp/intraday row).
 *
 * Uses dist/ (no broker, no network). Run: npm run build:api && node --test test/session-gate.test.js
 * Dates are November 2026, New York on EST (UTC−5), Bangkok UTC+7.
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

test('news blackout: closed now, resumes at 09:00 ET', () => {
    const r = g('scalp', EUR, '2026-11-10T13:30:00Z'); // Tue 08:30 ET
    assert.match(r.reason, /news blackout/);
    assert.equal(r.resumesAt.toISOString(), '2026-11-10T14:00:00.000Z');
    assert.equal(gate.fmtResume(r.resumesAt, at('2026-11-10T13:30:00Z')), '21:00 BKK / 09:00 ET (in 30 min)');
});

test('outside the scalp window: resumes at the next window, next day', () => {
    const r = g('scalp', XAU, '2026-11-10T18:00:00Z'); // Tue 13:00 ET
    assert.match(r.reason, /outside the scalp window/);
    assert.equal(r.resumesAt.toISOString(), '2026-11-11T08:00:00.000Z'); // Wed 03:00 ET
    // 13:00 ET Tuesday is already 01:00 Wednesday in Bangkok, so no weekday is printed
    assert.equal(gate.fmtBkk(r.resumesAt, at('2026-11-10T18:00:00Z')), '15:00 BKK');
    assert.equal(gate.fmtBkk(r.resumesAt, at('2026-11-10T16:00:00Z')), 'Wed 15:00 BKK'); // 23:00 BKK Tuesday
});

test('Friday cutoff waits through the weekend for an open market and a session window', () => {
    const fri = '2026-11-13T18:00:00Z'; // Fri 13:00 ET
    const xau = g('scalp', XAU, fri);
    assert.match(xau.reason, /Friday afternoon/);
    assert.equal(xau.resumesAt.toISOString(), '2026-11-16T08:00:00.000Z'); // Mon 03:00 ET
    const jpy = g('scalp', JPY, fri);
    assert.equal(jpy.resumesAt.toISOString(), '2026-11-16T00:00:00.000Z'); // Sun 19:00 ET, Tokyo window
    assert.match(gate.fmtResume(jpy.resumesAt, at(fri)), /^Mon 07:00 BKK \/ Sun 19:00 ET \(in 2 d 6 h\)$/);
});

test('swing and position are never gated; an open window is null', () => {
    assert.equal(g('swing', EUR, '2026-11-10T13:30:00Z'), null);
    assert.equal(g('position', XAU, '2026-11-10T13:30:00Z'), null);
    assert.equal(g('intraday', XAU, '2026-11-10T12:59:00Z'), null); // 07:59 ET
});

test('helpers: kind without clock times, modes grouped per instrument', () => {
    assert.equal(gate.gateKind('news blackout 08:00-09:00 ET (US data 08:30)'), 'news blackout');
    assert.equal(gate.gateKind('outside the scalp window (03:00-05:00 ET / 08:00-12:00 ET)'), 'outside the scalp window');
    const items = [
        { inst: 'XAUUSD', mode: 'scalp' },
        { inst: 'EURUSD', mode: 'scalp' },
        { inst: 'XAUUSD', mode: 'intraday' },
    ];
    assert.equal(gate.joinModes(items, true), 'XAUUSD scalp+intraday, EURUSD scalp');
    assert.equal(gate.joinModes(items.slice(0, 1), false), 'scalp');
});

function bot(instruments) {
    const o = Object.create(GoldAutomateService.prototype);
    const lines = [];
    o.gates = new Map();
    o.activity = { push: (level, message, tag) => lines.push({ level, message, tag }) };
    o.enabledInstruments = () => instruments;
    // one tick's gate work for intraday on every instrument, as tick() does it
    const tick = (iso) => {
        const now = at(iso);
        const et = require(path.join(DIST, 'gold/domain/market-hours')).etParts(now);
        const closed = [];
        const opened = [];
        const noTrade = [];
        for (const p of instruments) {
            const gt = o.trackGate('intraday', p, et, now, closed, opened);
            if (gt) noTrade.push({ inst: p.key, mode: 'intraday', gate: gt });
        }
        o.logGateChanges(closed, opened, now);
        return o.noTradeSummary(noTrade, now);
    };
    return { o, lines, tick };
}

test('System log: one NO TRADING line when the gate shuts, one TRADING OPEN line when it opens', () => {
    const { lines, tick } = bot([XAU, EUR]);
    assert.deepEqual(tick('2026-11-10T12:55:00Z'), []); // 07:55 ET, open
    assert.equal(lines.length, 0);

    const hb = tick('2026-11-10T13:00:00Z'); // 08:00 ET blackout starts
    assert.equal(lines.length, 2, 'XAU and EUR have different labels, so two lines'); // EUR adds ECB
    for (const l of lines) {
        assert.equal(l.level, 'warn');
        assert.match(l.message, /^⏸ NO TRADING — news blackout .* · trading resumes 21:00 BKK \/ 09:00 ET \(in 1 h 00 min\)$/);
    }
    assert.deepEqual(lines.map((l) => l.tag).sort(), ['EURUSD intraday', 'XAUUSD intraday']);
    assert.deepEqual(hb, ['⏸ NO TRADING until 21:00 BKK (news blackout): XAUUSD intraday, EURUSD intraday']);

    tick('2026-11-10T13:30:00Z'); // still the same blackout: nothing new
    assert.equal(lines.length, 2);

    assert.deepEqual(tick('2026-11-10T14:00:00Z'), []); // 09:00 ET
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[2], {
        level: 'ok',
        message: '▶ TRADING OPEN — new orders allowed again',
        tag: 'XAUUSD intraday, EURUSD intraday',
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
