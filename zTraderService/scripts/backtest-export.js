#!/usr/bin/env node
/**
 * รวมข้อมูลทุกแหล่งเป็นชุดเดียวสำหรับ backtest
 *
 *   cTrader deal (ผลกำไรจริง) ──positionId──> Mongo order (บริบทตอนสั่ง)
 *                                                  └──archiveFile──> archive JSON (TA + แท่งดิบ)
 *
 * อ่านอย่างเดียวทั้งหมด — ไม่แตะ service ที่รันอยู่ ไม่เขียนอะไรลง Mongo/archive
 * รันเมื่อไหร่ก็ได้ ไม่ต้อง build (ใช้ dist/ ที่มีอยู่)
 *
 * วิธีใช้:
 *   node scripts/backtest-export.js                     # 180 วัน -> backtest/
 *   node scripts/backtest-export.js --days 90
 *   node scripts/backtest-export.js --out /tmp/bt
 *   node scripts/backtest-export.js --bars              # ฝังแท่งดิบลงไปด้วย (ไฟล์ใหญ่)
 *
 * ได้ออกมา 3 ไฟล์:
 *   trades.csv   — 1 บรรทัด = 1 ไม้ที่ปิดแล้ว เปิดใน Excel/pandas ได้เลย
 *   trades.json  — เหมือนกันแต่มีบริบท TA เต็ม (decision + ตัวชี้วัด ณ ตอนสั่ง)
 *   summary.json — สรุปว่าข้อมูลครบแค่ไหน + ตรงไหนขาด (อ่านก่อนเริ่ม backtest)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);

const DAYS = Math.max(1, Math.min(180, parseInt(arg('days', '180'), 10) || 180));
const OUT = path.resolve(arg('out', path.join(ROOT, 'backtest')));
const WITH_BARS = has('bars');
const PORT = process.env.PORT || '6500';

// ---------- helpers ----------
const env = (() => {
    const f = path.join(ROOT, '.env');
    const out = {};
    if (fs.existsSync(f)) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
            if (m) out[m[1]] = m[2];
        }
    }
    return out;
})();

function die(msg, hint) {
    console.error(`\n❌ ${msg}`);
    if (hint) console.error(`   ${hint}`);
    process.exit(1);
}

/** ดึงประวัติเทรดจาก service ที่รันอยู่ (GET อย่างเดียว) */
function fetchHistory() {
    const key = env.API_KEY;
    if (!key) die('ไม่พบ API_KEY ใน .env');
    let raw;
    try {
        raw = execFileSync('curl', [
            '-sS', '--max-time', '120',
            `http://127.0.0.1:${PORT}/gold/history?days=${DAYS}`,
            '-H', `x-api-key: ${key}`,
        ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        die(`เรียก /gold/history ไม่ได้: ${e.message}`,
            `service รันอยู่ที่พอร์ต ${PORT} หรือเปล่า — ลอง: curl localhost:${PORT}/gold/status -H "x-api-key: ..."`);
    }
    let d;
    try { d = JSON.parse(raw); } catch { die('service ตอบไม่ใช่ JSON', raw.slice(0, 200)); }
    if (!d.trades) die(`service ตอบผิดรูปแบบ: ${d.message || JSON.stringify(d).slice(0, 200)}`);
    return d;
}

/** ดึง order ทั้งหมดจาก Mongo (ผ่าน container — ไม่ต้องลง driver เพิ่ม) */
function fetchOrders() {
    const uri = env.MONGO_URI || '';
    const local = uri.match(/127\.0\.0\.1:(\d+)/);
    const script = `
        const d = db.getSiblingDB("ztrader");
        print(JSON.stringify(d.orders.find({}, {
            _id:0, uuid:1, positionId:1, orderId:1, symbol:1, volume:1, orderType:1, side:1,
            price:1, status:1, strategy:1, mode:1, engine:1, stopLoss:1, takeProfit:1, tp2:1,
            entryPrice:1, closePrice:1, positionEvent:1, reason:1, playbookRef:1, invalidation:1,
            rrTp1:1, confidence:1, archiveFile:1, analysisSummary:1, createdAt:1, updatedAt:1
        }).toArray()));
    `;
    let raw;
    try {
        if (local) {
            raw = execFileSync('docker', ['exec', 'ztrader-mongo', 'mongosh', '--quiet', '--eval', script],
                { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        } else {
            raw = execFileSync('docker', ['run', '--rm', 'mongo:7', 'mongosh', uri, '--quiet', '--eval', script],
                { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        }
    } catch (e) {
        console.warn(`⚠ อ่าน Mongo ไม่ได้ (${String(e.message).slice(0, 80)}) — จะได้เฉพาะข้อมูลจาก cTrader`);
        return [];
    }
    const line = raw.split('\n').find((l) => l.trim().startsWith('['));
    try { return JSON.parse(line); } catch { return []; }
}

/** อ่าน archive 1 ไฟล์ — คืน decision + สรุปตัวชี้วัด (แท่งดิบใส่ให้เมื่อสั่ง --bars) */
function readArchive(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return null;
    let d;
    try { d = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
    const st = d.series_tail || {};
    // ค่าตัวชี้วัดของแท่งล่าสุดในแต่ละ series — พอสำหรับหา pattern โดยไม่ต้องแบกแท่งทั้งหมด
    const snap = {};
    for (const [k, bars] of Object.entries(st)) {
        const b = bars[bars.length - 1];
        if (!b) continue;
        snap[k] = {
            ts: b.ts, close: b.close, rsi: b.rsi, atr14: b.atr14, rvol20: b.rvol20,
            ema20: b.ema20, ema50: b.ema50, ema200: b.ema200,
        };
    }
    return {
        generated_utc: d.generated_utc,
        engine: d.engine,
        outcome: d.outcome,
        decision: d.decision || null,
        indicators: snap,
        bars_per_series: Object.values(st)[0]?.length ?? 0,
        ...(WITH_BARS ? { series_tail: st } : {}),
    };
}

// ---------- main ----------
console.log(`\n📦 รวมข้อมูล backtest — ย้อนหลัง ${DAYS} วัน\n`);

const hist = fetchHistory();
console.log(`  cTrader : ${hist.trades.length} ไม้ปิดแล้ว (แหล่งความจริงของกำไร/ขาดทุน)`);

const orders = fetchOrders();
console.log(`  Mongo   : ${orders.length} order`);

const byPos = new Map();
for (const o of orders) if (o.positionId != null) byPos.set(Number(o.positionId), o);

const archiveCache = new Map();
const rows = [];
const gap = { no_order: 0, no_archive: 0, archive_missing: 0, full: 0 };

for (const t of hist.trades) {
    const o = byPos.get(Number(t.position_id));
    if (!o) gap.no_order++;

    let arc = null;
    if (o && o.archiveFile) {
        if (!archiveCache.has(o.archiveFile)) archiveCache.set(o.archiveFile, readArchive(o.archiveFile));
        arc = archiveCache.get(o.archiveFile);
        if (!arc) gap.archive_missing++;
    } else if (o) {
        gap.no_archive++;
    }
    if (o && arc) gap.full++;

    rows.push({
        // ── ผลลัพธ์จริง (จาก cTrader — ครบเสมอ) ──
        closed_utc: t.closed_utc,
        position_id: t.position_id,
        instrument: t.instrument || o?.symbol || 'XAUUSD',
        side: t.side,
        lots: t.lots,
        entry: t.entry,
        close: t.close,
        gross_usd: t.gross_usd,
        net_usd: t.net_usd,
        hold_min: t.hold_min,
        exit_kind: t.exit_kind,
        h4_trend: t.h4_trend,
        with_trend: t.with_trend,

        // ── บริบทตอนสั่ง (จาก Mongo — ขาดได้) ──
        strategy: o?.strategy ?? t.strategy ?? null,
        mode: o?.mode ?? null,
        engine: o?.engine ?? null,
        order_type: o?.orderType ?? null,
        planned_entry: o?.price ?? null,
        planned_sl: o?.stopLoss ?? null,
        planned_tp1: o?.takeProfit ?? null,
        planned_tp2: o?.tp2 ?? null,
        rr_tp1: o?.rrTp1 ?? null,
        confidence: o?.confidence ?? null,
        playbook_ref: o?.playbookRef ?? null,
        entry_reason: o?.reason ?? null,
        invalidation: o?.invalidation ?? null,
        created_at: o?.createdAt ?? null,

        // ── บริบท TA (จาก archive — ขาดได้) ──
        archive_file: o?.archiveFile ?? null,
        ta: arc,

        // ── ตัวเลขที่คำนวณให้เลย ──
        slippage: o?.price != null && t.entry != null ? Number((t.entry - o.price).toFixed(5)) : null,
        planned_risk: o?.price != null && o?.stopLoss != null ? Number(Math.abs(o.price - o.stopLoss).toFixed(5)) : null,
        r_multiple: (() => {
            if (o?.price == null || o?.stopLoss == null || t.entry == null || t.close == null) return null;
            const risk = Math.abs(o.price - o.stopLoss);
            if (!risk) return null;
            const dir = t.side === 'BUY' ? 1 : -1;
            return Number(((dir * (t.close - t.entry)) / risk).toFixed(3));
        })(),
    });
}

/**
 * ไม้ซ้อนจากบั๊ก clientOrderId (แก้แล้ว 26 ส.ค. แต่ข้อมูลเก่ายังมีอยู่)
 * ออเดอร์รอหลายไม้ที่ราคาเดียวกัน fill พร้อมกัน -> นับเป็นหลายไม้ทั้งที่เป็น decision เดียว
 * ทำให้ทั้ง winrate และ P&L เพี้ยน (เจอ 8 กลุ่ม 11 ไม้ส่วนเกิน = -421 USD)
 * จึงต้องแยกรายงาน "ตามที่เกิดจริง" กับ "นับ decision ละครั้ง" ให้เห็นทั้งคู่
 */
const dupKey = (r) => [r.closed_utc.slice(0, 16), r.side, r.entry?.toFixed?.(2), r.close?.toFixed?.(2)].join('|');
const groups = new Map();
for (const r of rows) {
    const k = dupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
}
const dupGroups = [...groups.values()].filter((g) => g.length > 1);
const uniqueRows = [...groups.values()].map((g) => g[0]);
const extraPnl = dupGroups.reduce((a, g) => a + g.slice(1).reduce((b, r) => b + r.net_usd, 0), 0);
for (const [k, g] of groups) for (let i = 0; i < g.length; i++) {
    g[i].dup_group = g.length > 1 ? k : null;
    g[i].dup_index = g.length > 1 ? i : null;   // 0 = ไม้ต้นฉบับ · >0 = ไม้ส่วนเกินจากบั๊ก
}

const agg = (list) => {
    const w = list.filter((r) => r.net_usd > 0), l = list.filter((r) => r.net_usd < 0);
    const net = list.reduce((a, r) => a + r.net_usd, 0);
    const aw = w.length ? w.reduce((a, r) => a + r.net_usd, 0) / w.length : 0;
    const al = l.length ? Math.abs(l.reduce((a, r) => a + r.net_usd, 0) / l.length) : 0;
    const wr = list.length ? w.length / list.length : 0;
    return {
        trades: list.length, wins: w.length, losses: l.length,
        winrate: Math.round(wr * 100), net_usd: Number(net.toFixed(2)),
        avg_win: Number(aw.toFixed(2)), avg_loss: Number((-al).toFixed(2)),
        payoff: al ? Number((aw / al).toFixed(2)) : null,
        payoff_needed: wr ? Number(((1 - wr) / wr).toFixed(2)) : null,
    };
};

fs.mkdirSync(OUT, { recursive: true });

// ---- CSV (แบน เปิด Excel/pandas ได้ทันที) ----
const CSV_COLS = [
    'closed_utc', 'position_id', 'instrument', 'side', 'lots', 'entry', 'close',
    'gross_usd', 'net_usd', 'r_multiple', 'hold_min', 'exit_kind', 'h4_trend', 'with_trend',
    'strategy', 'mode', 'engine', 'order_type', 'planned_entry', 'planned_sl', 'planned_tp1',
    'rr_tp1', 'confidence', 'playbook_ref', 'slippage', 'planned_risk', 'dup_index', 'archive_file', 'entry_reason',
];
const esc = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
};
fs.writeFileSync(path.join(OUT, 'trades.csv'),
    [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => esc(r[c])).join(','))].join('\n') + '\n');

fs.writeFileSync(path.join(OUT, 'trades.json'), JSON.stringify(rows, null, 1));

// ---- summary: บอกตรง ๆ ว่าข้อมูลครบแค่ไหน ----
const n = rows.length || 1;
const cnt = (f) => rows.filter((r) => r[f] != null && r[f] !== '' && r[f] !== 'n/a' && r[f] !== 'unknown').length;
const summary = {
    generated_utc: new Date().toISOString(),
    days: DAYS,
    account_mode: hist.account_mode,
    trades: rows.length,
    period: rows.length ? { from: rows[rows.length - 1].closed_utc, to: rows[0].closed_utc } : null,
    pnl: hist.summary,
    by_strategy: hist.by_strategy,
    with_h4_trend: hist.with_h4_trend,
    against_h4_trend: hist.against_h4_trend,
    completeness: Object.fromEntries(
        ['strategy', 'mode', 'planned_sl', 'rr_tp1', 'confidence', 'playbook_ref', 'entry_reason', 'archive_file', 'r_multiple']
            .map((f) => [f, `${cnt(f)}/${rows.length}`]),
    ),
    gaps: {
        ...gap,
        note_th: [
            `${gap.no_order} ไม้ไม่มี order คู่กันใน Mongo — เกิดจาก order เก่าที่ยังไม่ได้บันทึก positionId`,
            `${gap.no_archive} ไม้มี order แต่ไม่มี archiveFile — ไม้ที่ไม่ได้มาจาก gold bot (SONIC/HIGH_WIN_RATE)`,
            `${gap.archive_missing} ไม้ชี้ไปยัง archive ที่หายไปจากดิสก์`,
            `${gap.full} ไม้มีข้อมูลครบทั้งโซ่ (ผลลัพธ์ + บริบทสั่ง + TA) — ใช้ backtest แบบเทียบผลได้`,
        ],
    },
    // สองมุม: ตามที่เกิดจริง (มีไม้ซ้อน) vs นับ decision ละครั้ง (ตัดไม้ซ้อนออก)
    as_happened: agg(rows),
    deduped: agg(uniqueRows),
    duplicate_orders: {
        groups: dupGroups.length,
        extra_trades: dupGroups.reduce((a, g) => a + g.length - 1, 0),
        extra_pnl_usd: Number(extraPnl.toFixed(2)),
        note_th: 'ไม้ซ้อนจากบั๊ก clientOrderId (แก้แล้ว 26 ส.ค.) — ออเดอร์รอราคาเดียวกัน fill พร้อมกัน',
        detail: dupGroups.map((g) => ({
            closed_utc: g[0].closed_utc, side: g[0].side, lots: g[0].lots, mode: g[0].mode,
            count: g.length, each_usd: g[0].net_usd,
            extra_usd: Number(g.slice(1).reduce((a, r) => a + r.net_usd, 0).toFixed(2)),
        })),
    },
    by_lot_size: (() => {
        const buckets = [[0, 0.05, '<=0.05'], [0.05, 0.3, '0.05-0.3'], [0.3, 1.1, '0.3-1.0'], [1.1, 999, '>1.0']];
        const out = {};
        for (const [lo, hi, lbl] of buckets) {
            const v = uniqueRows.filter((r) => r.lots > lo && r.lots <= hi);
            if (v.length) out[lbl] = agg(v);
        }
        return out;
    })(),
    bars_per_series: rows.find((r) => r.ta)?.ta?.bars_per_series ?? null,
    warning_th: [
        'แท่งใน archive มี 120 แท่ง/series — ไม่พอ recompute EMA200 ถ้าจะลองสูตรใหม่',
        'BE/trailing ไม่ถูกบันทึก SL ที่เลื่อนแล้วจึงไม่ตรงกับ planned_sl — exit_kind อาจอ่านผิด',
        'r_multiple คำนวณจาก planned_sl เดิม ไม่ได้หัก BE/trail',
    ],
};
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

// ---------- รายงาน ----------
const rel = path.relative(process.cwd(), OUT) || OUT;
console.log(`\n✅ เขียนแล้วที่ ${rel}/`);
console.log(`   trades.csv   ${rows.length} แถว`);
console.log(`   trades.json  ${(fs.statSync(path.join(OUT, 'trades.json')).size / 1e6).toFixed(1)} MB${WITH_BARS ? ' (ฝังแท่งดิบ)' : ''}`);
console.log(`   summary.json`);
console.log(`\n📊 ความครบของข้อมูล`);
for (const [k, v] of Object.entries(summary.completeness)) {
    const [a, b] = v.split('/').map(Number);
    console.log(`   ${k.padEnd(14)} ${v.padStart(8)}  ${'█'.repeat(Math.round((a / (b || 1)) * 20))}`);
}
if (dupGroups.length) {
    console.log(`\n⚠ ไม้ซ้อนจากบั๊ก clientOrderId: ${dupGroups.length} กลุ่ม · ส่วนเกิน ${summary.duplicate_orders.extra_trades} ไม้ · ${extraPnl >= 0 ? '+' : ''}${extraPnl.toFixed(2)} USD`);
    console.log(`   ตามที่เกิดจริง : ${summary.as_happened.trades} ไม้ · winrate ${summary.as_happened.winrate}% · ${summary.as_happened.net_usd >= 0 ? '+' : ''}${summary.as_happened.net_usd} USD`);
    console.log(`   นับ decision ละครั้ง: ${summary.deduped.trades} ไม้ · winrate ${summary.deduped.winrate}% · ${summary.deduped.net_usd >= 0 ? '+' : ''}${summary.deduped.net_usd} USD  ← ใช้ตัวนี้ประเมินสูตร`);
}
console.log(`\n💰 payoff ratio ${summary.deduped.payoff} · ต้องการ > ${summary.deduped.payoff_needed} ที่ winrate ${summary.deduped.winrate}%  ${summary.deduped.payoff > summary.deduped.payoff_needed ? '✅' : '❌ ยังไม่คุ้ม'}`);
console.log('\n📏 ขนาดไม้ vs ผลลัพธ์');
for (const [lbl, v] of Object.entries(summary.by_lot_size)) {
    console.log(`   lot ${lbl.padEnd(9)} ${String(v.trades).padStart(3)} ไม้ · ชนะ ${String(v.winrate).padStart(3)}% · ${(v.net_usd >= 0 ? '+' : '') + v.net_usd.toFixed(2)} USD`);
}
console.log(`\n🔗 ครบทั้งโซ่ (ใช้เทียบ decision กับผลจริงได้): ${gap.full}/${rows.length} ไม้`);
if (gap.full < 30) {
    console.log('   ⚠ น้อยเกินกว่าจะสรุปทางสถิติ — ใช้ backtest-run.js รัน TA บน archive แทนจะได้ตัวอย่างเยอะกว่ามาก');
}
console.log();
