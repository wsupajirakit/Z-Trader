/**
 * Regression: พิสูจน์ว่า flow ทอง (XAUUSD) ให้ผลเหมือนเดิมเป๊ะหลัง refactor เป็น multi-asset
 *
 * เทียบ "dist ปัจจุบัน" กับ "dist baseline" (build จาก tag savepoint ก่อนแก้) บน:
 *   1. archive จริงทุกรอบ (series_tail 120 แท่ง) — เวลาถูกตรึงไว้ที่ generated_utc ของรอบนั้น
 *   2. synthetic series ยาว (random walk seeded) ครบทุกโหมด หลายร้อยชุด
 *   3. marketStatus / sessionGuard / applyAssist / resolveVolume / checkRiskBudget
 *
 * วิธีรัน:  BASELINE_DIST=<path-to-baseline-dist> node test/instrument-regression.test.js
 *   (ถ้าไม่ตั้ง BASELINE_DIST จะหาใน ./dist-baseline)
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BASELINE_DIST || path.join(ROOT, 'dist-baseline');
if (!fs.existsSync(path.join(BASE, 'gold', 'gold-ta.service.js'))) {
    console.error(`baseline dist not found at ${BASE} — set BASELINE_DIST`);
    process.exit(2);
}
// baseline อยู่นอกโปรเจกต์ → ให้ require หา node_modules ของโปรเจกต์เจอ
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    try { return origResolve.call(this, request, parent, isMain, options); } catch (e) {
        if (!request.startsWith('.') && !path.isAbsolute(request)) {
            return origResolve.call(this, request, parent, isMain, { ...(options || {}), paths: [ROOT] });
        }
        throw e;
    }
};

const OLD = {
    Ta: require(path.join(BASE, 'gold/gold-ta.service.js')).GoldTaService,
    Auto: require(path.join(BASE, 'gold/gold-automate.service.js')).GoldAutomateService,
    mh: require(path.join(BASE, 'gold/market-hours.js')),
    ind: require(path.join(BASE, 'gold/indicators.js')),
    modes: require(path.join(BASE, 'gold/gold-modes.js')),
};
const NEW = {
    Ta: require(path.join(ROOT, 'dist/gold/analysis/gold-ta.service.js')).GoldTaService,
    Auto: require(path.join(ROOT, 'dist/gold/gold-automate.service.js')).GoldAutomateService,
    mh: require(path.join(ROOT, 'dist/gold/domain/market-hours.js')),
    ind: require(path.join(ROOT, 'dist/gold/domain/indicators.js')),
    inst: require(path.join(ROOT, 'dist/gold/domain/instruments.js')),
};

let pass = 0, fail = 0;
const failures = [];
const t = (name, cond, detail) => {
    if (cond) { pass++; console.log('  ✓', name); } else { fail++; failures.push(name + (detail ? ` :: ${detail}` : '')); }
};
const quietLogger = { log() { }, warn() { }, error() { }, debug() { } };
const mkTa = (Cls) => { const o = new Cls(); o.logger = quietLogger; return o; };
const oldTa = mkTa(OLD.Ta), newTa = mkTa(NEW.Ta);
const XAU = NEW.inst.XAUUSD_PROFILE;

// ---------- helpers ----------
const realNow = Date.now;
const freeze = (ts) => { Date.now = () => ts; };
const unfreeze = () => { Date.now = realNow; };

function normalizeDecision(d) {
    if (!d) return d;
    const c = { ...d };
    // บรรทัดแรกของ summary เป็น text change ที่อนุญาต (เพิ่มชื่อตราสาร) — ตัดทิ้งก่อนเทียบ
    if (typeof c.analysis_summary_th === 'string') {
        c.analysis_summary_th = c.analysis_summary_th.split('\n').filter((l) => !l.startsWith('โหมด ')).join('\n');
    }
    delete c.ai_assist;
    // near_miss/near_miss_rule เป็น "ป้ายกำกับ" ที่เพิ่มเข้ามาใหม่ (ประตู AI) — ไม่ใช่ผลการเทรด
    // ตัดออกก่อนเทียบ แล้วไปตรวจแยกด้านล่างว่าเป็นการ "เพิ่มข้อมูล" ไม่ใช่ "เปลี่ยนคำตัดสิน"
    delete c.near_miss;
    delete c.near_miss_rule;
    return c;
}

/** ฟิลด์ที่กระทบเงินจริง — ต้องเท่าเดิมเป๊ะเสมอ */
const TRADE_FIELDS = ['order_type', 'entry', 'sl', 'tp1', 'tp2', 'rr_tp1', 'confidence', 'size', 'playbook_ref'];
const sameTrade = (a, b) => {
    if (!a || !b) return a === b;
    return TRADE_FIELDS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
};
const same = (a, b) => JSON.stringify(normalizeDecision(a)) === JSON.stringify(normalizeDecision(b));

// ---------- 1. archive จริง ----------
const MODES = ['scalp', 'intraday', 'swing', 'position'];
const RR = { scalp: 1.5, intraday: 1.8, swing: 2.0, position: 2.5 };
let archiveRuns = 0, archiveTrades = 0, archiveMismatch = 0;
const archiveDir = path.join(ROOT, 'archive');
if (fs.existsSync(archiveDir)) {
    for (const mode of MODES) {
        const dir = path.join(archiveDir, mode);
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
            let j;
            try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
            if (!j.series_tail || !Object.keys(j.series_tail).length) continue;
            const ts = Date.parse(j.generated_utc) || realNow();
            // เดินเวลาหลายจุดรอบ ๆ เวลาจริงของรอบ เพื่อเจอทั้งแท่งปิด/ยังไม่ปิด และกรอบเอเชียครบ/ไม่ครบ
            for (const shift of [0, 7 * 60_000 + 10_000, 2 * 3_600_000]) {
                freeze(ts + shift);
                let a, b, c;
                try {
                    a = oldTa.analyze(mode, j.series_tail, { rrMin: RR[mode], sizeCap: null });
                    b = newTa.analyze(mode, j.series_tail, { rrMin: RR[mode], sizeCap: null, profile: XAU });
                    c = newTa.analyze(mode, j.series_tail, { rrMin: RR[mode], sizeCap: null }); // default profile
                } finally { unfreeze(); }
                archiveRuns++;
                if (a.order_type !== 'NO_TRADE') archiveTrades++;
                const ok = same(a, b) && same(a, c);
                if (!ok && archiveMismatch < 5) {
                    console.log(`MISMATCH ${mode}/${f} shift=${shift}\n old=${JSON.stringify(normalizeDecision(a)).slice(0, 400)}\n new=${JSON.stringify(normalizeDecision(b)).slice(0, 400)}`);
                }
                if (!ok) archiveMismatch++;
            }
        }
    }
}
t(`archive regression: ${archiveRuns} runs (${archiveTrades} trade decisions) identical`, archiveRuns > 0 && archiveMismatch === 0, `${archiveMismatch} mismatches`);

// ---------- 2. synthetic series ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function synth(seed, tf, n, endTs, base, vol) {
    const r = rng(seed);
    const ms = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 }[tf];
    const bars = [];
    let px = base;
    let trend = 0;
    for (let i = 0; i < n; i++) {
        if (r() < 0.03) trend = (r() - 0.5) * vol * 0.6;
        const o = px;
        const drift = trend + (r() - 0.5) * vol;
        const cl = Math.max(base * 0.5, o + drift);
        const hi = Math.max(o, cl) + r() * vol * 0.8;
        const lo = Math.min(o, cl) - r() * vol * 0.8;
        bars.push({ ts: endTs - (n - i) * ms, open: o, high: hi, low: lo, close: cl, volume: Math.round(500 + r() * 3000) });
        px = cl;
    }
    return bars;
}
const SETS = {
    scalp: [['5m', 500], ['15m', 400], ['dxy_15m', 300], ['us10y_15m', 300], ['usdjpy_15m', 300]],
    intraday: [['15m', 400], ['30m', 350], ['1h', 400], ['dxy_1h', 300], ['us10y_1h', 300], ['vix_1h', 300], ['usdjpy_1h', 300], ['spy_1h', 300]],
    swing: [['1h', 400], ['4h', 360], ['1d', 300], ['dxy_4h', 300], ['dxy_1d', 300], ['us10y_1d', 300], ['vix_1d', 300], ['wti_1d', 300], ['btcusdt_1d', 300], ['spy_1d', 300], ['xagusd_1d', 300]],
    position: [['1d', 300], ['1w', 200], ['dxy_1w', 200], ['us10y_1w', 200], ['xagusd_1w', 200], ['gdx_1d', 300], ['gdx_1w', 200]],
};
function buildSeries(seed, mode, nowTs, enrichFn, mainKey = 'xauusd', base = 4000, vol = 6) {
    const out = {};
    SETS[mode].forEach(([k, n], i) => {
        const isMain = !k.includes('_');
        const key = isMain ? `${mainKey}_${k}` : k;
        const tf = isMain ? k : k.split('_')[1];
        const b = isMain ? base : 100;
        const v = isMain ? vol * ({ '5m': 0.15, '15m': 0.3, '30m': 0.45, '1h': 0.6, '4h': 1.2, '1d': 2.5, '1w': 5 }[tf]) : 0.8;
        out[key] = enrichFn(synth(seed * 131 + i * 17, tf, n, nowTs, b, v));
    });
    return out;
}
let synRuns = 0, synTrades = 0, synMismatch = 0;
// เวลา "ตอนนี้" หลายจุดในวัน (UTC) เพื่อให้กรอบเอเชียครบและ session ต่าง ๆ
const NOWS = [Date.UTC(2026, 7, 18, 8, 40), Date.UTC(2026, 7, 18, 13, 5), Date.UTC(2026, 7, 19, 2, 0)];
for (let seed = 1; seed <= 120; seed++) {
    for (const mode of MODES) {
        for (const nowTs of NOWS) {
            const sOld = buildSeries(seed, mode, nowTs, OLD.ind.enrich);
            const sNew = buildSeries(seed, mode, nowTs, NEW.ind.enrich);
            freeze(nowTs + 20_000);
            let a, b;
            try {
                a = oldTa.analyze(mode, sOld, { rrMin: RR[mode], sizeCap: seed % 3 === 0 ? 'half' : null });
                b = newTa.analyze(mode, sNew, { rrMin: RR[mode], sizeCap: seed % 3 === 0 ? 'half' : null, profile: XAU });
            } finally { unfreeze(); }
            synRuns++;
            if (a.order_type !== 'NO_TRADE') synTrades++;
            if (!same(a, b)) {
                synMismatch++;
                if (synMismatch <= 3) console.log(`SYN MISMATCH seed=${seed} ${mode}\n old=${JSON.stringify(normalizeDecision(a)).slice(0, 300)}\n new=${JSON.stringify(normalizeDecision(b)).slice(0, 300)}`);
            }
        }
    }
}
t(`synthetic regression: ${synRuns} runs (${synTrades} trade decisions) identical`, synRuns > 0 && synMismatch === 0, `${synMismatch} mismatches`);
t('synthetic produced real trade decisions (coverage)', synTrades > 20, `${synTrades}`);

// ---------- 3. marketStatus (metals default) ----------
let mhRuns = 0, mhMismatch = 0;
for (let ts = Date.UTC(2026, 7, 1); ts < Date.UTC(2026, 7, 29); ts += 7 * 60_000 + 13_000) {
    const a = OLD.mh.marketStatus(new Date(ts));
    const b = NEW.mh.marketStatus(new Date(ts));
    const c = NEW.mh.marketStatus(new Date(ts), NEW.mh.METALS_HOURS);
    mhRuns++;
    const pick = (m) => [m.open, m.phase, m.minutes_to_open, m.minutes_to_close, m.next_open_utc, m.et_time].join('|');
    if (pick(a) !== pick(b) || pick(a) !== pick(c)) mhMismatch++;
}
t(`marketStatus metals identical over ${mhRuns} timestamps`, mhMismatch === 0, `${mhMismatch}`);

// ---------- 4. automate private helpers ----------
function fakeAuto(Cls, overrides = {}) {
    const o = Object.create(Cls.prototype);
    o.logger = quietLogger;
    o.overrides = new Map();
    o.configService = { get: (k, d) => (overrides[k] !== undefined ? overrides[k] : d) };
    o.instruments = { active: XAU, cachedSymbolId: () => 41 };
    // Object.create ไม่รัน constructor -> field initializer (private ticks = new Map())
    // ไม่ทำงาน -> ต้องตั้งเองไม่งั้น getLastTick() ที่ applyAssist เรียกจะ throw
    o.ticks = new Map();
    return o;
}
const envs = [{}, { GOLD_RISK_USD_PER_TRADE: '150', GOLD_MAX_LOT: '0.5' }, { GOLD_SIZING: 'fixed', GOLD_BASE_LOT: '0.2' }];
let volRuns = 0, volMismatch = 0, budgetRuns = 0, budgetMismatch = 0, budgetTightened = 0;
for (const env of envs) {
    const a = fakeAuto(OLD.Auto, env), b = fakeAuto(NEW.Auto, env);
    const isFixed = (env.GOLD_SIZING || 'risk').toLowerCase() === 'fixed';
    for (const size of ['quarter', 'half', 'full']) for (const cap of [null, 'half', 'quarter']) {
        for (const [entry, sl] of [[4000, 3980], [4000, 3600], [4012.5, 4013.9], [3950, 4050]]) {
            volRuns++;
            const va = a.resolveVolume(size, cap, entry, sl);
            const vb = b.resolveVolume(size, cap, entry, sl, XAU);
            const vc = b.resolveVolume(size, cap, entry, sl);
            if (va !== vb || va !== vc) volMismatch++;
            const d = { order_type: 'BUY_LIMIT', entry, sl, tp1: entry + 50, size };
            const ra = a.checkRiskBudget(d, cap), rb = b.checkRiskBudget(d, cap, XAU);
            if (isFixed) {
                // จงใจเปลี่ยน: เดิม sizing=fixed ปิดด่านงบทิ้งทั้งด่าน (คืน null เสมอ)
                // ตอนนี้คุมงบด้วย — เปลี่ยนได้ทางเดียวคือ "เข้มขึ้น" (null -> ข้อความ)
                // ห้ามหลวมลง (ข้อความ -> null) เพราะนั่นแปลว่าปล่อยไม้ที่เคยถูกกันออกไป
                budgetRuns++;
                if (ra !== null && rb === null) budgetMismatch++;
                if (ra === null && rb !== null) budgetTightened++;
            } else if ((ra === null) !== (rb === null)) {
                volMismatch++;
            }
        }
    }
}
t(`resolveVolume identical + checkRiskBudget โหมด risk เท่าเดิม (${volRuns} เคส × 3 env)`, volMismatch === 0, `${volMismatch}`);
t(`checkRiskBudget โหมด fixed เข้มขึ้นอย่างเดียว ไม่หลวมลง (${budgetRuns} เคส, เข้มขึ้น ${budgetTightened})`, budgetMismatch === 0, `${budgetMismatch}`);

// sessionGuard: เทียบ null/ไม่ null ทุก 5 นาทีตลอดสัปดาห์
let sgRuns = 0, sgMismatch = 0;
{
    const a = fakeAuto(OLD.Auto), b = fakeAuto(NEW.Auto);
    for (let ts = Date.UTC(2026, 7, 17); ts < Date.UTC(2026, 7, 24); ts += 5 * 60_000) {
        const RealDate = Date;
        // etInfo ใช้ new Date() → แทนที่ชั่วคราว
        global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [ts])); } static now() { return ts; } };
        try {
            for (const mode of MODES) {
                sgRuns++;
                const ra = a.sessionGuard(mode), rb = b.sessionGuard(mode, XAU), rc = b.sessionGuard(mode);
                if ((ra === null) !== (rb === null) || (ra === null) !== (rc === null)) sgMismatch++;
            }
        } finally { global.Date = RealDate; }
    }
}
t(`sessionGuard identical (${sgRuns} checks)`, sgMismatch === 0, `${sgMismatch}`);

// ฟิลด์ near_miss ที่เพิ่มใหม่ต้องเป็น "ป้ายกำกับ" ล้วน ๆ
// ติดเฉพาะกับ NO_TRADE · ไม่โผล่ในไม้ที่เทรดจริง · ไม่เปลี่ยนคำตัดสินใด ๆ
{
    const { classifyNoTrade } = require(path.join(ROOT, 'dist/gold/analysis/gold-ta.service'));
    const ta = new NEW.Ta();
    ta.logger = quietLogger;
    let checked = 0, badPlacement = 0, badFlag = 0;
    for (const mode of MODES) {
        const dir = path.join(ROOT, 'archive', mode);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).slice(-80)) {
            let d;
            try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
            if (!d.series_tail || !Object.keys(d.series_tail).length) continue;
            let out;
            try { out = ta.analyze(mode, d.series_tail, { rrMin: RR[mode], sizeCap: null, profile: XAU }); } catch { continue; }
            checked++;
            if (out.order_type !== 'NO_TRADE' && out.near_miss !== undefined) badPlacement++;
            if (out.order_type === 'NO_TRADE') {
                const expect = classifyNoTrade(out.reason);
                if (out.near_miss !== expect.near_miss) badFlag++;
            }
        }
    }
    t(`near_miss ติดเฉพาะ NO_TRADE ไม่โผล่ในไม้จริง (${checked} รอบ)`, badPlacement === 0, `${badPlacement}`);
    t('near_miss ตรงกับ classifyNoTrade เสมอ', badFlag === 0, `${badFlag}`);
}

// applyAssist — จงใจ "ไม่เหมือนเดิม": เพิ่ม rail กัน AI ทำให้ไม้เสี่ยงขึ้น
// จึงไม่เทียบกับ baseline แต่ยืนยันสัญญาใหม่แทน (AI ลดความเสี่ยงได้อย่างเดียว)
// ข้อที่ต้องคงเดิม: ไม่มี ai = ผลเท่า TA เป๊ะ · VETO = ไม่เข้า
{
    const a = fakeAuto(OLD.Auto), b = fakeAuto(NEW.Auto);
    const TA = { order_type: 'SELL_LIMIT', entry: 4000, sl: 4020, tp1: 3960, tp2: 3940, rr_tp1: 2, confidence: 7, size: 'full', reason: 'x', playbook_ref: 'swing #1', invalidation: '', valid_until_utc: null, analysis_summary_th: '' };
    const ai = (o) => ({ verdict: 'ADJUST', entry: null, sl: null, tp1: null, tp2: null, size: 'full', confidence: null, key_levels: '', risk_note_th: '', reason_th: 'r', ...o });

    // 1) ไม่มี AI = ต้องเท่าของเดิมเป๊ะ (ทางที่บอทเดินอยู่ทุกวันนี้ เพราะยังไม่มี GEMINI_API_KEY)
    t('applyAssist: ไม่มี ai → ผลเท่า baseline เป๊ะ',
        JSON.stringify(a.applyAssist(TA, null, 2.0)) === JSON.stringify(b.applyAssist(TA, null, 2.0)));

    // 2) VETO = ไม่เข้า (เหมือนเดิม)
    const veto = b.applyAssist(TA, ai({ verdict: 'VETO', confidence: 3 }), 2.0);
    t('applyAssist: VETO → NO_TRADE', veto.order_type === 'NO_TRADE');

    // 3) AI ยก confidence ไม่ได้ — เดิม 8 > TA 7 แล้วผ่านด่าน min_confidence ได้
    const up = b.applyAssist(TA, ai({ confidence: 9 }), 2.0);
    t('applyAssist: AI ยก confidence ไม่ได้', up.confidence === TA.confidence);

    // 4) AI ลด confidence ได้
    const down = b.applyAssist(TA, ai({ confidence: 4 }), 2.0);
    t('applyAssist: AI ลด confidence ได้', down.confidence === 4);

    // 5) AI บีบ SL แคบกว่าครึ่งของ TA ไม่ได้ (TA risk = 20 → ขอ 5 = ต้องถูกปัด)
    const tight = b.applyAssist(TA, ai({ entry: 4000, sl: 4005, tp1: 3960 }), 2.0);
    t('applyAssist: บีบ SL แคบเกิน → ใช้ระดับ TA', tight.sl === TA.sl && tight.entry === TA.entry);

    // 6) AI เพิ่มขนาดไม้ไม่ได้ (เหมือนเดิม)
    const bigger = b.applyAssist({ ...TA, size: 'quarter' }, ai({ size: 'full' }), 2.0);
    t('applyAssist: AI เพิ่มขนาดไม้ไม่ได้', bigger.size === 'quarter');

    // 7) ขยับ entry ไกลเกินครึ่งของระยะ SL = คนละไม้ ใช้ระดับ TA
    const far = b.applyAssist(TA, ai({ entry: 4300, sl: 4320, tp1: 4200 }), 2.0);
    t('applyAssist: entry ไกลเกิน → ใช้ระดับ TA', far.entry === TA.entry);
}

console.log(`\n${fail === 0 ? '✅ REGRESSION ผ่านหมด' : '❌ REGRESSION พัง'} ${pass}/${pass + fail}`);
for (const f of failures) console.log('  ✗', f);
process.exit(fail ? 1 : 0);
