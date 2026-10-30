// The configuration record attached to every round and order (backtests group trades by it).
const assert = require('node:assert/strict');
const test = require('node:test');
const { configHash, newTrace, withoutSecrets, ROUND_CONTEXT_SCHEMA } = require('../dist/gold/records/round-context');

const base = () => ({
    app: { version: '1.0.0', commit: null },
    account_mode: 'DEMO',
    instrument: { key: 'XAUUSD', symbol_id: 41, digits: 2, pip: 0.1, units_per_lot: 100 },
    mode: { name: 'swing', rr_min: 1.8, period_min: 60, tradable_modes: ['swing'] },
    engine: 'ta',
    data_source: 'local',
    risk_profile: { id: 'builtin:conservative', name: 'Conservative', modified: false, changed: [] },
    risk: {
        sizing: 'risk',
        risk_usd_per_trade: 117.62,
        base_lot: 0.1,
        daily_max_loss_usd: 470.5,
        max_open_positions: 2,
        max_open_positions_total: 3,
        min_confidence: 8,
        loss_cooldown_bars: 6,
        scalp_max_per_day: 4,
        max_lot: 0.1,
        risk_tolerance: 1.2,
    },
    ai: {
        mode_selected: 'lead',
        mode_effective: 'lead',
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        thinking: 'low',
        strictness: 'normal',
        strictness_min_confidence: null,
        gate: 'near_miss',
        temperature: 0.2,
        max_calls_per_day: 10,
    },
    overrides: { GOLD_RISK_USD_PER_TRADE: '117.62' },
});

test('hash is stable, short, and independent of key order', () => {
    const a = base();
    const b = JSON.parse(JSON.stringify(a, Object.keys(a).reverse()));
    assert.match(configHash(a), /^[0-9a-f]{12}$/);
    assert.equal(configHash(a), configHash({ ...b, ...a }));
});

test('hash changes with anything that changes decisions, not with the app version or "modified" bookkeeping', () => {
    const h = configHash(base());
    assert.notEqual(configHash({ ...base(), risk: { ...base().risk, risk_usd_per_trade: 120 } }), h);
    assert.notEqual(configHash({ ...base(), ai: { ...base().ai, strictness: 'strict' } }), h);
    assert.notEqual(configHash({ ...base(), mode: { ...base().mode, name: 'intraday' } }), h);
    assert.equal(configHash({ ...base(), app: { version: '9.9.9', commit: 'abc' } }), h);
    assert.equal(
        configHash({ ...base(), risk_profile: { ...base().risk_profile, modified: true, changed: ['x'] } }),
        h,
    );
});

test('credentials never reach a record', () => {
    const out = withoutSecrets(
        new Map([
            ['GOLD_RISK_USD_PER_TRADE', '100'],
            ['GEMINI_API_KEY', 'x'],
            ['ACCESS_TOKEN', 'x'],
            ['APP_SECRET', 'x'],
            ['TV_PASSWORD', 'x'],
        ]),
    );
    assert.deepEqual(out, { GOLD_RISK_USD_PER_TRADE: '100' });
});

test('a new trace carries schema, hash and empty per-round slots', () => {
    const t = newTrace(base());
    assert.equal(t.schema, ROUND_CONTEXT_SCHEMA);
    assert.equal(t.config_hash, configHash(base()));
    assert.deepEqual(t.guards, {});
    assert.equal(t.sizing, null);
});
