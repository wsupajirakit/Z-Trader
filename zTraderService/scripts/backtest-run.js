#!/usr/bin/env node
/**
 * รัน TA ย้อนหลังบนแท่งจริงที่เก็บไว้ใน archive แล้ววัดผลว่า "ถ้าเข้าไม้นั้นจะได้อะไร"
 *
 * ต่างจาก backtest-export.js ตรงที่ไม่ต้องพึ่งโซ่ Mongo (ซึ่งครบแค่ 7 ไม้)
 * → ใช้ทุกรอบที่มีแท่งดิบ (741 ไฟล์) เป็นตัวอย่างได้เลย มากกว่า 100 เท่า
 *
 * วัดผลยังไง: หลังรอบที่ TA เสนอไม้ ให้เดินแท่งของรอบถัด ๆ ไปในโหมดเดียวกัน
 * แล้วดูว่าราคาแตะ SL ก่อนหรือ TP ก่อน (ตัดสินจาก high/low ของแท่งจริง)
 *   - แตะ SL ก่อน     -> แพ้ -1R
 *   - แตะ TP1 ก่อน    -> ชนะ +R ตามที่วางไว้
 *   - ไม่แตะทั้งคู่จนหมดข้อมูล -> ไม่รู้ผล (ไม่นับ)
 *   - แท่งเดียวแตะทั้งคู่ -> นับเป็นแพ้ (สมมติแบบระมัดระวัง — ไม่รู้ลำดับภายในแท่ง)
 *
 * อ่านอย่างเดียวทั้งหมด ไม่แตะ service ที่รันอยู่ ไม่ต้อง build (ใช้ dist/ ที่มีอยู่)
 *
 * วิธีใช้:
 *   node scripts/backtest-run.js                          # ทุกโหมด
 *   node scripts/backtest-run.js --mode scalp
 *   node scripts/backtest-run.js --rr 1.2                 # ลองผ่อน R:R ขั้นต่ำ
 *   node scripts/backtest-run.js --compare dist-baseline  # เทียบสองสูตร
 *   node scripts/backtest-run.js --csv /tmp/bt/replay.csv
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
process.env.NODE_PATH = [path.join(ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const argv = process.argv.slice(2);
const arg = (k, d) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const ONLY_MODE = arg('mode', null);
const RR_OVERRIDE = arg('rr', null) ? parseFloat(arg('rr', null)) : null;
const COMPARE = arg('compare', null);
const CSV_OUT = arg('csv', null);
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;

const MODES = ONLY_MODE ? [ONLY_MODE] : ['scalp', 'intraday', 'swing', 'position'];
const RR_DEFAULT = { scalp: 1.5, intraday: 1.8, swing: 2.0, position: 2.5 };
/** TF ที่ใช้เดินราคาไปข้างหน้าเพื่อดูว่าแตะ SL/TP ก่อน — TF เล็กสุดของโหมด = ละเอียดสุด */
const WALK_TF = { scalp: '5m', intraday: '15m', swing: '1h', position: '1d' };

function loadTa(distDir) {
    const p = path.join(ROOT, distDir, 'gold/gold-ta.service.js');
    if (!fs.existsSync(p)) {
        console.error(`❌ ไม่พบ ${path.relative(ROOT, p)}`);
        if (distDir === 'dist') console.error('   ยังไม่ได้ build? ใช้ dist ที่มีอยู่เดิมก็ได้ — สคริปต์นี้ไม่ build ให้');
        else console.error('   สร้างด้วย: npm run baseline');
        process.exit(2);
    }
    const { GoldTaService } = require(p);
    // baseline เก่ากว่างาน multi-asset จะไม่มี instruments.js — profile เป็นแค่ข้อมูล
    // ใช้ของ dist ปัจจุบันแทนได้ (ตัว TA ต่างหากที่เป็นสิ่งที่เราเทียบกัน)
    let XAUUSD_PROFILE;
    const own = path.join(ROOT, distDir, 'gold/instruments.js');
    try {
        XAUUSD_PROFILE = require(fs.existsSync(own) ? own : path.join(ROOT, 'dist/gold/instruments.js')).XAUUSD_PROFILE;
    } catch {
        console.error(`❌ ไม่พบ instruments.js ทั้งใน ${distDir} และ dist`);
        process.exit(2);
    }
    const svc = new GoldTaService();
    svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
    return { svc, profile: XAUUSD_PROFILE };
}

/** เก็บทุกรอบของโหมดหนึ่ง เรียงตามเวลา — ใช้แท่งของรอบหลัง ๆ เดินราคาไปข้างหน้า */
function loadRounds(mode) {
    const dir = path.join(ROOT, 'archive', mode);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        const full = path.join(dir, f);
        if (fs.statSync(full).size < 50_000) continue;   // ไฟล์เล็ก = ไม่มีแท่งดิบ
        let d;
        try { d = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
        if (!d.series_tail || !Object.keys(d.series_tail).length) continue;
        out.push({ file: `${mode}/${f}`, ts: Date.parse(d.generated_utc), series: d.series_tail, outcome: d.outcome });
    }
    return out;
}

/**
 * เดินแท่งไปข้างหน้าเพื่อหาว่าแตะ SL หรือ TP1 ก่อน
 * ใช้แท่งจากรอบถัด ๆ ไปของโหมดเดียวกัน (แต่ละรอบเก็บ 120 แท่งล่าสุด จึงต่อกันได้)
 */
function resolveOutcome(rounds, startIdx, mode, profile, dec) {
    const key = `${profile.key.toLowerCase()}_${WALK_TF[mode]}`;
    const isBuy = dec.order_type.startsWith('BUY');
    const entry = dec.entry, sl = dec.sl, tp = dec.tp1;
    const risk = Math.abs(entry - sl);
    if (!risk) return null;

    let filled = false;
    const seen = new Set();
    for (let i = startIdx; i < rounds.length; i++) {
        const bars = rounds[i].series[key];
        if (!bars) continue;
        for (const b of bars) {
            if (b.ts <= rounds[startIdx].ts - 1) continue;   // แท่งเก่ากว่ารอบที่เสนอ
            if (seen.has(b.ts)) continue;
            seen.add(b.ts);

            // ออเดอร์รอ — ต้องถูก fill ก่อนถึงจะนับผล
            if (!filled) {
                const touched = dec.order_type.endsWith('LIMIT')
                    ? (isBuy ? b.low <= entry : b.high >= entry)
                    : (isBuy ? b.high >= entry : b.low <= entry);
                if (!touched) continue;
                filled = true;
            }
            const hitSl = isBuy ? b.low <= sl : b.high >= sl;
            const hitTp = isBuy ? b.high >= tp : b.low <= tp;
            const rTp = Math.abs(tp - entry) / risk;
            // แท่งเดียวแตะทั้ง SL และ TP = ไม่รู้ลำดับภายในแท่ง
            // เดิมนับเป็นแพ้เงียบ ๆ ซึ่งลงโทษโหมดที่ SL/TP แคบเทียบช่วงแท่งมากกว่าโดยระบบ
            // (scalp: SL->TP $24 บนแท่ง 5m ช่วง $3.98 = 6 เท่า · intraday $98/$6.14 = 16 เท่า)
            // จึงแยกเป็นหมวด AMBIG แล้วรายงานเป็นช่วง (แย่สุด/ดีสุด) แทนการเดาข้างเดียว
            if (hitSl && hitTp) return { result: 'AMBIG', r: null, rIfWin: rTp, ts: b.ts, filled: true };
            if (hitSl) return { result: 'SL', r: -1, ts: b.ts, filled: true };
            if (hitTp) return { result: 'TP', r: rTp, ts: b.ts, filled: true };
        }
    }
    return filled ? { result: 'OPEN', r: null, filled: true } : { result: 'NO_FILL', r: null, filled: false };
}

function runOne(distDir, label) {
    const { svc, profile } = loadTa(distDir);
    const rows = [];
    const stat = {};

    for (const mode of MODES) {
        const rounds = loadRounds(mode);
        if (!rounds.length) continue;
        const rrMin = RR_OVERRIDE ?? RR_DEFAULT[mode];
        const s = stat[mode] = { rounds: rounds.length, setups: 0, near: 0, no_setup: 0, err: 0, tp: 0, sl: 0, ambig: 0, open: 0, nofill: 0, rSum: 0, ambigR: 0 };
        const limit = LIMIT ? Math.min(LIMIT, rounds.length) : rounds.length;

        for (let i = 0; i < limit; i++) {
            // TA เช็ค session/หน้าต่างเวลาด้วย new Date() — ถ้าไม่ตรึงเวลาไว้ที่ "ตอนนั้น"
            // รอบเก่าจะถูกตัดทิ้งหมดเพราะเทียบกับเวลาปัจจุบัน (เจอจริง: setup 2/744 แทนที่จะเป็น ~50)
            let dec;
            const RealDate = Date;
            const at = rounds[i].ts;
            global.Date = class extends RealDate {
                constructor(...a) { super(...(a.length ? a : [at])); }
                static now() { return at; }
            };
            try {
                dec = svc.analyze(mode, rounds[i].series, { rrMin, sizeCap: null, profile });
            } catch { s.err++; continue; }
            finally { global.Date = RealDate; }

            if (dec.order_type === 'NO_TRADE') {
                if (dec.near_miss) s.near++; else s.no_setup++;
                continue;
            }
            s.setups++;
            const res = resolveOutcome(rounds, i, mode, profile, dec) || { result: 'OPEN', r: null };
            if (res.result === 'TP') { s.tp++; s.rSum += res.r; }
            else if (res.result === 'SL') { s.sl++; s.rSum += res.r; }
            else if (res.result === 'AMBIG') { s.ambig++; s.ambigR += res.rIfWin; }
            else if (res.result === 'NO_FILL') s.nofill++;
            else s.open++;

            rows.push({
                run: label, mode, file: rounds[i].file, ts: new Date(rounds[i].ts).toISOString(),
                order_type: dec.order_type, entry: dec.entry, sl: dec.sl, tp1: dec.tp1,
                rr_tp1: dec.rr_tp1, confidence: dec.confidence, size: dec.size,
                playbook: dec.playbook_ref, result: res.result, r: res.r,
            });
        }
    }
    return { rows, stat };
}

// ---------- รัน ----------
console.log(`\n🔁 replay TA บน archive จริง${RR_OVERRIDE ? ` · บังคับ R:R ขั้นต่ำ = ${RR_OVERRIDE}` : ''}\n`);

const main = runOne('dist', 'current');
const base = COMPARE ? runOne(COMPARE, 'baseline') : null;

function report(stat, title) {
    console.log(`── ${title} ──`);
    const hdr = ['โหมด', 'รอบ', 'setup', 'เฉียด', 'TP', 'SL', 'คลุมเครือ', 'ไม่ fill', 'R แย่สุด', 'R ดีสุด'];
    console.log('  ' + hdr.map((h, i) => h.padStart(i === 0 ? 9 : 10)).join(''));
    const tot = { rounds: 0, setups: 0, near: 0, no_setup: 0, tp: 0, sl: 0, ambig: 0, open: 0, nofill: 0, rSum: 0, ambigR: 0 };
    const line = (m, s) => {
        const worst = s.rSum - s.ambig;             // คลุมเครือ = แพ้ทุกไม้
        const best = s.rSum + s.ambigR;             // คลุมเครือ = ชนะทุกไม้
        console.log('  ' + [m, s.rounds, s.setups, s.near, s.tp, s.sl, s.ambig, s.nofill, worst.toFixed(1), best.toFixed(1)]
            .map((v, i) => String(v).padStart(i === 0 ? 9 : 10)).join(''));
    };
    for (const [m, s] of Object.entries(stat)) {
        for (const k of Object.keys(tot)) tot[k] += s[k] || 0;
        line(m, s);
    }
    line('รวม', tot);
    const closed = tot.tp + tot.sl;
    if (closed || tot.ambig) {
        const worst = tot.rSum - tot.ambig, best = tot.rSum + tot.ambigR;
        console.log(`\n  รู้ผลชัด ${closed} ไม้ · คลุมเครือ ${tot.ambig} ไม้ (แท่งเดียวแตะทั้ง SL และ TP)`);
        console.log(`  ผลรวมอยู่ในช่วง ${worst.toFixed(1)}R ถึง ${best.toFixed(1)}R`);
        if (closed) console.log(`  winrate เฉพาะไม้ที่ชัด: ${Math.round((tot.tp / closed) * 100)}%`);
        const n = closed + tot.ambig;
        if (n < 30) console.log(`  ⚠ ตัวอย่างแค่ ${n} ไม้ — น้อยกว่า 30 ยังสรุปทางสถิติไม่ได้ ใช้ดูทิศทางเท่านั้น`);
        if (tot.ambig > closed * 0.3) console.log('  ⚠ ไม้คลุมเครือเยอะ — ช่วงผลกว้าง ควรลด TF ที่ใช้เดินราคาให้ละเอียดกว่านี้');
    }
    if (tot.nofill) console.log(`  ${tot.nofill} ไม้ไม่เคยถูก fill (ออเดอร์รอหมดอายุ) — นี่คือเหตุผลที่ไม้จริงน้อยกว่า setup มาก`);
    console.log();
    return tot;
}

const a = report(main.stat, COMPARE ? 'สูตรปัจจุบัน (dist)' : 'ผลลัพธ์');
if (base) {
    const b = report(base.stat, `baseline (${COMPARE})`);
    const d = (x, y) => { const v = x - y; return (v > 0 ? '+' : '') + v.toFixed(1); };
    console.log('── ต่างกันเท่าไหร่ (ปัจจุบัน − baseline) ──');
    console.log(`  setup       ${d(a.setups, b.setups)}`);
    console.log(`  TP          ${d(a.tp, b.tp)}`);
    console.log(`  SL          ${d(a.sl, b.sl)}`);
    console.log(`  คลุมเครือ   ${d(a.ambig, b.ambig)}`);
    console.log(`  R แย่สุด    ${d(a.rSum - a.ambig, b.rSum - b.ambig)}`);
    console.log(`  R ดีสุด     ${d(a.rSum + a.ambigR, b.rSum + b.ambigR)}`);
    console.log();
}

if (CSV_OUT) {
    const cols = ['run', 'mode', 'ts', 'file', 'order_type', 'entry', 'sl', 'tp1', 'rr_tp1', 'confidence', 'size', 'playbook', 'result', 'r'];
    const all = [...main.rows, ...(base ? base.rows : [])];
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    fs.mkdirSync(path.dirname(path.resolve(CSV_OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(CSV_OUT), [cols.join(','), ...all.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
    console.log(`📄 เขียน ${all.length} แถวลง ${CSV_OUT}\n`);
}

console.log('หมายเหตุ: ไม้ "คลุมเครือ" คือแท่งเดียวแตะทั้ง SL และ TP — ไม่รู้ลำดับภายในแท่ง\n         จึงรายงานเป็นช่วง (แย่สุด = แพ้หมด · ดีสุด = ชนะหมด) แทนการเดาข้างเดียว\n');
