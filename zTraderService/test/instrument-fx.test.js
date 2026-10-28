/**
 * Unit tests สำหรับโปรไฟล์คู่เงิน (EURUSD / GBPUSD / USDJPY) — ต้อง build ก่อน (node dist)
 *   - lot sizing / risk budget ใช้มูลค่าต่อจุดของแต่ละคู่ถูกต้อง
 *   - ชั่วโมงตลาด forex (24/5 ไม่มีพักรายวัน) vs โลหะ
 *   - session guard ต่อคู่ (USDJPY มีหน้าต่าง Tokyo)
 *   - TA engine ให้ราคาทศนิยมถูกต้อง, หลบเลขกลม 00/50, เป้า scalp เป็น pips
 *   - helper: usdPerUnitMovePerLot / roundPrice / toPips
 * วิธีรัน: node test/instrument-fx.test.js
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inst = require(path.join(ROOT, 'dist/gold/domain/instruments.js'));
const mh = require(path.join(ROOT, 'dist/gold/domain/market-hours.js'));
const { GoldTaService } = require(path.join(ROOT, 'dist/gold/analysis/gold-ta.service.js'));
const { GoldAutomateService } = require(path.join(ROOT, 'dist/gold/gold-automate.service.js'));
const { enrich } = require(path.join(ROOT, 'dist/gold/domain/indicators.js'));

let pass = 0, fail = 0; const failures = [];
const t = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? ` :: ${detail}` : '')); } };
const quiet = { log() { }, warn() { }, error() { }, debug() { } };
const { XAUUSD_PROFILE: XAU, EURUSD_PROFILE: EUR, GBPUSD_PROFILE: GBP, USDJPY_PROFILE: JPY, INSTRUMENTS, getProfile } = inst;

// ---------- helpers ----------
t('usdPerUnitMovePerLot XAU = 100', inst.usdPerUnitMovePerLot(XAU, 4000) === 100);
t('usdPerUnitMovePerLot EURUSD = 100000', inst.usdPerUnitMovePerLot(EUR, 1.08) === 100000);
t('usdPerUnitMovePerLot USDJPY @150 = 666.67', Math.abs(inst.usdPerUnitMovePerLot(JPY, 150) - 100000 / 150) < 1e-9);
t('pip value EURUSD 1 lot = $10', Math.abs(inst.usdPerUnitMovePerLot(EUR, 1.08) * EUR.pip - 10) < 1e-9);
t('pip value USDJPY 1 lot @150 ≈ $6.67', Math.abs(inst.usdPerUnitMovePerLot(JPY, 150) * JPY.pip - 6.6667) < 0.001);
t('roundPrice EURUSD 5 decimals', inst.roundPrice(EUR, 1.0852349) === 1.08523);
t('roundPrice USDJPY 3 decimals', inst.roundPrice(JPY, 150.12345) === 150.123);
t('roundPrice XAU 2 decimals', inst.roundPrice(XAU, 4012.345) === 4012.35);
t('toPips EURUSD 0.0030 = 30', inst.toPips(EUR, 0.0030) === 30);
t('toPips XAU $2.5 = 25', inst.toPips(XAU, 2.5) === 25);
t('getProfile unknown → XAU', getProfile('FOO').key === 'XAUUSD');
t('getProfile lower-case', getProfile('eurusd').key === 'EURUSD');
t('seriesKey', inst.seriesKey(EUR, '15m') === 'eurusd_15m');
for (const k of inst.INSTRUMENT_KEYS) {
    const p = INSTRUMENTS[k];
    for (const m of ['scalp', 'intraday', 'swing', 'position']) {
        const spec = p.modes[m];
        t(`${k} ${m} has main sets`, spec && spec.sets.some((s) => s.symbol === k));
        t(`${k} ${m} has playbook ≥4`, spec && spec.playbook.length >= 4);
        t(`${k} ${m} companions all have Yahoo mapping`, spec.sets.filter((s) => s.symbol !== k).every((s) => !!require(path.join(ROOT, 'dist/gold/domain/gold-modes.js')).YAHOO_SYMBOL[s.symbol]), spec.sets.map((s) => s.symbol).join(','));
    }
    t(`${k} companions keys are lowercase`, p.companions.every((c) => c.sym === c.sym.toLowerCase()));
    t(`${k} brief sections non-empty`, ['drivers_th', 'behaviour_th', 'sessions_th', 'levels_th', 'risks_th', 'events_th'].every((s) => p.brief[s].length >= 3));
}

// ---------- market hours ----------
const et = (y, m, d, hh, mm) => new Date(Date.UTC(y, m, d, hh + 4, mm)); // สิงหาคม = EDT (UTC-4)
t('FX Sunday 17:00 ET closed (opens 17:05)', !mh.marketStatus(et(2026, 7, 23, 17, 0), mh.FX_HOURS).open);
t('FX Sunday 17:05 ET open', mh.marketStatus(et(2026, 7, 23, 17, 5), mh.FX_HOURS).open);
t('metals Sunday 17:30 ET still closed', !mh.marketStatus(et(2026, 7, 23, 17, 30), mh.METALS_HOURS).open);
t('metals Sunday 18:00 ET open', mh.marketStatus(et(2026, 7, 23, 18, 0), mh.METALS_HOURS).open);
t('FX weekday 17:30 ET open (no daily break)', mh.marketStatus(et(2026, 7, 18, 17, 30), mh.FX_HOURS).open);
t('metals weekday 17:30 ET daily break', mh.marketStatus(et(2026, 7, 18, 17, 30), mh.METALS_HOURS).phase === 'daily_break');
t('FX Friday 16:55 ET closed', !mh.marketStatus(et(2026, 7, 21, 16, 55), mh.FX_HOURS).open);
t('FX Friday 16:54 ET open', mh.marketStatus(et(2026, 7, 21, 16, 54), mh.FX_HOURS).open);
t('FX Saturday closed', mh.marketStatus(et(2026, 7, 22, 12, 0), mh.FX_HOURS).phase === 'weekend');
{
    const s = mh.marketStatus(et(2026, 7, 18, 10, 0), mh.FX_HOURS); // Tue 10:00 ET
    const expect = 3 * 24 * 60 + (16 * 60 + 55) - 10 * 60; // ถึงศุกร์ 16:55
    t('FX minutes_to_close to Friday close', s.minutes_to_close === expect, `${s.minutes_to_close} vs ${expect}`);
    const s2 = mh.marketStatus(et(2026, 7, 21, 16, 55), mh.FX_HOURS);
    t('FX Friday close → minutes_to_open ~ Sunday 17:05', s2.minutes_to_open === (24 * 60 - (16 * 60 + 55)) + 24 * 60 + (17 * 60 + 5), `${s2.minutes_to_open}`);
}

// ---------- session guard per instrument ----------
function fakeAuto(profile, env = {}) {
    const o = Object.create(GoldAutomateService.prototype);
    o.logger = quiet; o.overrides = new Map();
    o.configService = { get: (k, d) => (env[k] !== undefined ? env[k] : d) };
    o.instruments = { active: profile, cachedSymbolId: () => 1 };
    return o;
}
function withTime(ts, fn) {
    const RealDate = Date;
    global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [ts])); } static now() { return ts; } };
    try { return fn(); } finally { global.Date = RealDate; }
}
const tueET = (hh, mm) => et(2026, 7, 18, hh, mm).getTime();
t('XAU scalp 20:00 ET blocked', withTime(tueET(20, 0), () => fakeAuto(XAU).sessionGuard('scalp')) !== null);
t('USDJPY scalp 20:00 ET allowed (Tokyo window)', withTime(tueET(20, 0), () => fakeAuto(JPY).sessionGuard('scalp')) === null);
t('EURUSD scalp 20:00 ET blocked', withTime(tueET(20, 0), () => fakeAuto(EUR).sessionGuard('scalp')) !== null);
t('GBPUSD intraday 02:10 ET blocked (UK data)', withTime(tueET(2, 10), () => fakeAuto(GBP).sessionGuard('intraday')) !== null);
t('EURUSD intraday 02:40 ET allowed', withTime(tueET(2, 40), () => fakeAuto(EUR).sessionGuard('intraday')) === null);
t('all: 08:30 ET blackout', inst.INSTRUMENT_KEYS.every((k) => withTime(tueET(8, 30), () => fakeAuto(INSTRUMENTS[k]).sessionGuard('intraday')) !== null));
t('swing never session-blocked', withTime(tueET(8, 30), () => fakeAuto(EUR).sessionGuard('swing')) === null);
t('Friday 13:00 ET blocked for scalp (all)', inst.INSTRUMENT_KEYS.every((k) => withTime(et(2026, 7, 21, 13, 0).getTime(), () => fakeAuto(INSTRUMENTS[k]).sessionGuard('scalp')) !== null));

// ---------- lot sizing / risk budget ----------
{
    // เพดาน lot แยกรายตราสารแล้ว — GOLD_MAX_LOT คุมเฉพาะทอง (ตามชื่อ)
    // FX ต้องตั้งผ่าน GOLD_MAX_LOT_<KEY> ไม่งั้นตกไปใช้ profile.maxLot (FX = 2)
    const a = fakeAuto(EUR, { GOLD_RISK_USD_PER_TRADE: '1500', GOLD_MAX_LOT_EURUSD: '50' });
    const lots = a.resolveVolume('full', null, 1.0800, 1.0770, EUR); // SL 30 pips → $1500 / (30×$10) = 5 lots
    t('EURUSD risk sizing 30 pips → 5 lots', lots === 5, `${lots}`);
    const j = fakeAuto(JPY, { GOLD_RISK_USD_PER_TRADE: '1500', GOLD_MAX_LOT_USDJPY: '50' });
    const lotsJ = j.resolveVolume('full', null, 150.000, 149.700, JPY); // SL 30 pips @150 → pip $6.667 → 7.5 lots
    t('USDJPY risk sizing 30 pips @150 → 7.5 lots', lotsJ === 7.5, `${lotsJ}`);

    // สัญญาใหม่: GOLD_MAX_LOT ต้องไม่ไปบีบ FX อีกต่อไป (นี่คือบั๊กที่เพิ่งแก้ 28 ส.ค.)
    const clamp = fakeAuto(EUR, { GOLD_RISK_USD_PER_TRADE: '1500', GOLD_MAX_LOT: '0.01' });
    t('GOLD_MAX_LOT ไม่บีบ EURUSD (ใช้ profile.maxLot=2)',
        clamp.resolveVolume('full', null, 1.0800, 1.0770, EUR) === 2,
        `${clamp.resolveVolume('full', null, 1.0800, 1.0770, EUR)}`);
    const gold = fakeAuto(XAU, { GOLD_RISK_USD_PER_TRADE: '1500', GOLD_MAX_LOT: '0.01' });
    t('GOLD_MAX_LOT ยังบีบทองเหมือนเดิม (ของเดิมไม่พัง)',
        gold.resolveVolume('full', null, 4000, 3980, XAU) === 0.01);
    t('ไม่ตั้งอะไรเลย -> FX ใช้ profile.maxLot = 2',
        fakeAuto(GBP, { GOLD_RISK_USD_PER_TRADE: '1500' }).resolveVolume('full', null, 1.3000, 1.2970, GBP) === 2);
    const x = fakeAuto(XAU, { GOLD_RISK_USD_PER_TRADE: '1500', GOLD_MAX_LOT: '50' });
    t('XAU risk sizing $20 SL → 0.75 lots', x.resolveVolume('full', null, 4000, 3980, XAU) === 0.75);
    t('half size halves lots', a.resolveVolume('half', null, 1.0800, 1.0770, EUR) === 2.5);
    t('cap quarter', a.resolveVolume('full', 'quarter', 1.0800, 1.0770, EUR) === 1.25);
    // budget: ไม้ที่แม้ 0.01 lot ยังเกินงบ
    const tiny = fakeAuto(EUR, { GOLD_RISK_USD_PER_TRADE: '5', GOLD_RISK_TOLERANCE: '1.2' });
    const msg = tiny.checkRiskBudget({ order_type: 'BUY_LIMIT', entry: 1.0800, sl: 1.0700, tp1: 1.1, size: 'full' }, null, EUR); // 100 pips × $0.1/pip@0.01lot = $10 > 6
    t('EURUSD risk budget rejects SL too wide for 0.01 lot', typeof msg === 'string' && msg.includes('0.0100'), msg);
    const fine = fakeAuto(EUR, { GOLD_RISK_USD_PER_TRADE: '50' }).checkRiskBudget({ order_type: 'BUY_LIMIT', entry: 1.0800, sl: 1.0780, tp1: 1.1, size: 'full' }, null, EUR);
    t('EURUSD risk budget ok when within', fine === null, String(fine));
}

// ---------- TA engine on FX synthetic series ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function synth(seed, tf, n, endTs, base, vol) {
    const r = rng(seed);
    const ms = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 }[tf];
    const bars = []; let px = base; let trend = 0;
    for (let i = 0; i < n; i++) {
        if (r() < 0.03) trend = (r() - 0.5) * vol * 0.6;
        const o = px; const cl = Math.max(base * 0.5, o + trend + (r() - 0.5) * vol);
        const hi = Math.max(o, cl) + r() * vol * 0.8; const lo = Math.min(o, cl) - r() * vol * 0.8;
        bars.push({ ts: endTs - (n - i) * ms, open: o, high: hi, low: lo, close: cl, volume: Math.round(500 + r() * 3000) });
        px = cl;
    }
    return bars;
}
const TFV = { '5m': 0.15, '15m': 0.3, '30m': 0.45, '1h': 0.6, '4h': 1.2, '1d': 2.5, '1w': 5 };
function buildSeries(profile, mode, seed, nowTs, base, vol) {
    const out = {};
    profile.modes[mode].sets.forEach((s, i) => {
        const isMain = s.symbol === profile.key;
        const b = isMain ? base : 100, v = isMain ? vol * TFV[s.tf] : 0.8;
        out[`${s.symbol.toLowerCase()}_${s.tf}`] = enrich(synth(seed * 131 + i * 17, s.tf, s.nBars, nowTs, b, v));
    });
    return out;
}
const ta = new GoldTaService(); ta.logger = quiet;
const decimals = (v) => { const s = String(v); return s.includes('.') ? s.split('.')[1].length : 0; };
const isRoundish = (p, v) => { const m = v / p.round.step; return Math.abs(m - Math.round(m)) * p.round.step < p.round.buffer - 1e-9; };
const RR = { scalp: 1.5, intraday: 1.8, swing: 2.0, position: 2.5 };
for (const [p, base, vol] of [[EUR, 1.08, 0.0012], [GBP, 1.27, 0.0016], [JPY, 150, 0.12]]) {
    let trades = 0, badDecimals = 0, roundHits = 0, badRR = 0, scalpTpBad = 0, runs = 0, errors = 0;
    for (let seed = 1; seed <= 80; seed++) {
        for (const mode of ['scalp', 'intraday', 'swing', 'position']) {
            for (const nowTs of [Date.UTC(2026, 7, 18, 8, 40), Date.UTC(2026, 7, 18, 13, 5)]) {
                const series = buildSeries(p, mode, seed, nowTs, base, vol);
                const realNow = Date.now; Date.now = () => nowTs + 20_000;
                let d;
                try { d = ta.analyze(mode, series, { rrMin: RR[mode], sizeCap: null, profile: p }); }
                catch (e) { errors++; continue; }
                finally { Date.now = realNow; }
                runs++;
                if (d.order_type === 'NO_TRADE') continue;
                trades++;
                for (const f of ['entry', 'sl', 'tp1', 'tp2']) if (decimals(d[f]) > p.digits) badDecimals++;
                // entry ผ่าน avoidRound เสมอ · SL ด้วย ยกเว้น fallback ของโหมด position (sl = entry ∓ 1.3×ATR
                // ไม่ผ่าน avoidRound — พฤติกรรมเดิมของทองเหมือนกัน ไม่แตะเพื่อไม่ให้ผลทองเปลี่ยน)
                if (isRoundish(p, d.entry) || (mode !== 'position' && isRoundish(p, d.sl))) roundHits++;
                const risk = Math.abs(d.entry - d.sl), reward = Math.abs(d.tp1 - d.entry);
                if (reward / risk < RR[mode] * 0.9) badRR++;
                if (mode === 'scalp') {
                    const tpDist = Math.abs(d.tp1 - d.entry);
                    // เป้า scalp ต้องอยู่ในช่วง [min, max] ของโปรไฟล์ (บวก tolerance จาก capBeforeRound)
                    if (tpDist < p.scalp.min - p.round.tpBuffer - 1e-9 || tpDist > p.scalp.max + p.round.tpBuffer + 1e-9) scalpTpBad++;
                }
            }
        }
    }
    t(`${p.key} TA ran without errors (${runs} runs, ${trades} trades)`, errors === 0 && runs > 0, `${errors} errors`);
    t(`${p.key} TA produced trades`, trades > 5, `${trades}`);
    t(`${p.key} prices respect ${p.digits} decimals`, badDecimals === 0, `${badDecimals}`);
    t(`${p.key} entry/SL avoid round levels (${p.round.label_th})`, roundHits === 0, `${roundHits}`);
    t(`${p.key} R:R ≥ mode minimum`, badRR === 0, `${badRR}`);
    t(`${p.key} scalp TP within profile pips range`, scalpTpBad === 0, `${scalpTpBad}`);
}

console.log(`\n${fail === 0 ? '✅ FX ผ่านหมด' : '❌ FX พัง'} ${pass}/${pass + fail}`);
for (const f of failures) console.log('  ✗', f);
process.exit(fail ? 1 : 0);
