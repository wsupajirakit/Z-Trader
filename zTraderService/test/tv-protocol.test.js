/**
 * Unit tests for the TradingView wire format (src/integrations/tradingview/tv-protocol.ts), the
 * session throttle and the JWT expiry helper. Pure functions only, no network. Needs a build first.
 * Run: node --test test/tv-protocol.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const DIST = path.resolve(__dirname, '../dist/integrations/tradingview');
const p = require(path.join(DIST, 'tv-protocol.js'));
const { TvThrottle } = require(path.join(DIST, 'tv-throttle.js'));
const { jwtExpiryMs } = require(path.join(DIST, 'tv-auth.js'));

describe('encodeFrame / encodeMessage', () => {
    it('frames a string payload with its length', () => {
        assert.equal(p.encodeFrame('~h~12'), '~m~5~m~~h~12');
    });

    it('frames a session message as JSON {m, p}', () => {
        const f = p.encodeMessage('chart_create_session', ['cs_abc', '']);
        const body = '{"m":"chart_create_session","p":["cs_abc",""]}';
        assert.equal(f, `~m~${body.length}~m~${body}`);
    });
});

describe('decodeFrames', () => {
    it('splits several packets in one websocket frame', () => {
        const a = '{"m":"du","p":[]}';
        const raw = p.encodeFrame(a) + p.encodeFrame('~h~3') + p.encodeFrame({ session_id: 'x' });
        assert.deepEqual(p.decodeFrames(raw), [a, '~h~3', '{"session_id":"x"}']);
    });

    it('round-trips encodeFrame', () => {
        const msgs = ['x', '{"a":[1,2,3]}', '~h~99', ''];
        assert.deepEqual(p.decodeFrames(msgs.map((m) => p.encodeFrame(m)).join('')), msgs);
    });

    it('survives a wrong declared length by cutting at the next header', () => {
        const raw = '~m~3~m~{"m":"du"}~m~4~m~~h~1';
        assert.deepEqual(p.decodeFrames(raw), ['{"m":"du"}', '~h~1']);
    });

    it('returns nothing for garbage and a truncated header', () => {
        assert.deepEqual(p.decodeFrames('hello'), []);
        assert.deepEqual(p.decodeFrames('~m~12'), []);
    });
});

describe('parsePacket', () => {
    it('recognises heartbeats, messages, the hello and junk', () => {
        assert.deepEqual(p.parsePacket('~h~7'), { kind: 'heartbeat', raw: '~h~7' });
        assert.deepEqual(p.parsePacket('{"m":"du","p":[1]}'), { kind: 'message', method: 'du', params: [1] });
        assert.equal(p.parsePacket('{"session_id":"abc","protocol":"json"}').kind, 'hello');
        assert.equal(p.parsePacket('not json').kind, 'invalid');
        assert.equal(p.parsePacket('[1,2]').kind, 'invalid');
    });

    it('treats a message without params as an empty list', () => {
        assert.deepEqual(p.parsePacket('{"m":"quote_completed"}'), {
            kind: 'message',
            method: 'quote_completed',
            params: [],
        });
    });
});

describe('extractSeriesBars', () => {
    const update = {
        m: 'timescale_update',
        p: [
            'cs_x',
            {
                s1: {
                    node: 'n',
                    s: [
                        { i: 1, v: [1793339700.0, 3996.73, 3996.73, 3988.14, 3991.53, 2887.0] },
                        { i: 0, v: [1793339400.0, 3999.15, 4000.155, 3996.475, 3996.83, 1290.0] },
                        { i: 2, v: [1793340000, 1.1, 1.2, 1.0, 1.15] },
                        { i: 3, v: [1793340300, 'x', 1, 1, 1] },
                        { i: 4 },
                    ],
                },
            },
        ],
    };

    it('maps v:[time,o,h,l,c,vol] to sorted bars and drops broken entries', () => {
        const bars = p.extractSeriesBars(update.p, 's1');
        assert.deepEqual(bars, [
            { time: 1793339400, open: 3999.15, high: 4000.155, low: 3996.475, close: 3996.83, volume: 1290 },
            { time: 1793339700, open: 3996.73, high: 3996.73, low: 3988.14, close: 3991.53, volume: 2887 },
            { time: 1793340000, open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 0 }, // no volume field
        ]);
    });

    it('keeps the later entry for a repeated time (du updates)', () => {
        const du = ['cs', { s1: { s: [{ i: 49, v: [100, 1, 2, 0.5, 1.5, 10] }, { i: 49, v: [100, 1, 2.5, 0.5, 2, 12] }] } }];
        assert.deepEqual(p.extractSeriesBars(du, 's1'), [
            { time: 100, open: 1, high: 2.5, low: 0.5, close: 2, volume: 12 },
        ]);
    });

    it('returns [] for another series or a malformed body', () => {
        assert.deepEqual(p.extractSeriesBars(update.p, 's2'), []);
        assert.deepEqual(p.extractSeriesBars(['cs'], 's1'), []);
        assert.deepEqual(p.extractSeriesBars(['cs', { s1: { s: 'x' } }], 's1'), []);
    });
});

describe('session helpers', () => {
    it('builds the resolve_symbol argument', () => {
        assert.equal(p.symbolSpec('OANDA:XAUUSD'), '={"symbol":"OANDA:XAUUSD","adjustment":"splits"}');
    });

    it('makes tvDatafeed-style session ids', () => {
        assert.match(p.sessionId('cs'), /^cs_[a-z]{12}$/);
        assert.equal(
            p.sessionId('qs', () => 0),
            'qs_aaaaaaaaaaaa',
        );
    });

    it('sends the setup sequence in order, anonymous when there is no token', () => {
        const msgs = p.seriesSetupMessages(null, 'cs_x', 'OANDA:EURUSD', '5', 300).flatMap(p.decodeFrames);
        const parsed = msgs.map((m) => JSON.parse(m));
        assert.deepEqual(
            parsed.map((m) => m.m),
            ['set_auth_token', 'chart_create_session', 'resolve_symbol', 'create_series', 'switch_timezone'],
        );
        assert.deepEqual(parsed[0].p, ['unauthorized_user_token']);
        assert.deepEqual(parsed[3].p, ['cs_x', 's1', 's1', 'symbol_1', '5', 300]);
        assert.equal(JSON.parse(p.seriesSetupMessages('tok', 'cs', 'A:B', '1D', 2).flatMap(p.decodeFrames)[0]).p[0], 'tok');
    });

    it('describes errors without our internal ids', () => {
        assert.equal(p.describeError('symbol_error', ['cs_abcdef', 'symbol_1', 'invalid symbol']), 'symbol_error: invalid symbol');
        assert.equal(p.describeError('critical_error', ['cs_abcdef']), 'critical_error');
    });

    it('validates EXCHANGE:SYMBOL', () => {
        assert.ok(p.isValidFullSymbol('OANDA:XAUUSD'));
        assert.ok(p.isValidFullSymbol('FX_IDC:EURUSD'));
        assert.ok(!p.isValidFullSymbol('oanda:xauusd'));
        assert.ok(!p.isValidFullSymbol('XAUUSD'));
        assert.ok(!p.isValidFullSymbol('A:B"},{"x'));
    });
});

describe('TvThrottle', () => {
    it('spaces reservations by the minimum interval and honours a cooldown', async () => {
        let now = 1_000;
        const th = new TvThrottle(500, () => now);
        await th.waitTurn(); // immediate
        // the next two slots are 500 ms and 1000 ms away; time does not move, so check the bookkeeping
        const t2 = th.waitTurn();
        const t3 = th.waitTurn();
        assert.ok(t2 instanceof Promise && t3 instanceof Promise);
        th.tripCooldown(10_000);
        assert.equal(th.cooldownLeftMs(), 10_000);
        now += 10_000;
        assert.equal(th.cooldownLeftMs(), 0);
    });

    it('really waits on the clock', async () => {
        const th = new TvThrottle(60);
        const keep = setInterval(() => undefined, 10); // the throttle's timers are unref'd
        const t0 = Date.now();
        await th.waitTurn();
        await th.waitTurn();
        await th.waitTurn();
        clearInterval(keep);
        assert.ok(Date.now() - t0 >= 110, `took ${Date.now() - t0} ms`);
    });
});

describe('jwtExpiryMs', () => {
    it('reads exp from a JWT payload, 0 for anything else', () => {
        const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString('base64url');
        assert.equal(jwtExpiryMs(`h.${payload}.s`), 1_800_000_000_000);
        assert.equal(jwtExpiryMs('not-a-jwt'), 0);
        assert.equal(jwtExpiryMs('a.b.c'), 0);
    });
});
