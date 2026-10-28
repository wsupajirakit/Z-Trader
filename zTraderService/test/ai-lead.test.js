/**
 * โหมด AI lead — AI หาไม้เองเมื่อ TA ไม่เจอ setup
 *
 * ทดสอบสองชั้นที่กันความเสี่ยง (ไม่ต้องมี API key ไม่ต่อเน็ต):
 *   1. propose()      — prompt ถูกต้อง + parse คำตอบให้ตรง contract (ผิดรูปแบบ = null)
 *   2. applyProposal() — ด่านที่แปลงข้อเสนอเป็นไม้จริง ต้องทิ้งไม้ที่ไม่ปลอดภัยทุกกรณี
 *
 * รัน: npm run build && node test/ai-lead.test.js
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROJECT = path.resolve(process.env.ZTRADER_ROOT || path.join(__dirname, '..'));
if (!fs.existsSync(path.join(PROJECT, 'package.json'))) { console.error('run from the repo root'); process.exit(2); }
process.env.NODE_PATH = [path.join(PROJECT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const OUT = path.join(PROJECT, 'dist/gold');
if (!fs.existsSync(path.join(OUT, 'ai/gold-gemini.service.js'))) { console.error('ต้อง npm run build ก่อน'); process.exit(2); }

const { GoldGeminiService } = require(path.join(OUT, 'ai/gold-gemini.service'));
const { GoldAutomateService } = require(path.join(OUT, 'gold-automate.service'));
const { enrich } = require(path.join(OUT, 'domain/indicators'));
const { XAUUSD_PROFILE, EURUSD_PROFILE } = require(path.join(OUT, 'domain/instruments'));
const { GoogleGenAI } = require('@google/genai');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
};

// ---------- fixtures ----------
const NOW = Date.UTC(2026, 7, 24, 13, 7, 0);   // จันทร์ 09:07 ET = ในหน้าต่าง overlap
const env = { GEMINI_API_KEY: 'fake-key', GOLD_AI_THINKING: 'high' };
const cfgSvc = { get: (k, d) => (env[k] !== undefined ? env[k] : d) };

function bars(n, tfMs, base, step, now) {
    const out = [];
    let px = base;
    const start = now - (n - 1) * tfMs;
    for (let i = 0; i < n; i++) {
        const drift = (i % 7 - 3) * step * 0.3;
        const o = px, c = px + drift, h = Math.max(o, c) + step, l = Math.min(o, c) - step;
        out.push({ ts: start + i * tfMs, open: o, high: h, low: l, close: c, volume: 100 + (i % 13) * 10 });
        px = c;
    }
    return out;
}
const series = {
    xauusd_5m: enrich(bars(300, 5 * 60000, 4000, 0.8, NOW)),
    xauusd_15m: enrich(bars(250, 15 * 60000, 4000, 1.5, NOW)),
    xauusd_1d: enrich(bars(120, 86400000, 3900, 12, NOW)),
};
const runtime = { rrMin: 1.5, openPositions: 'ไม่มี', sizeCap: null, dailyPnlUsd: -42.5 };
const news = [{ source: 'CNBC', title: 'Gold steady ahead of CPI', pubDate: 'Mon, 24 Aug 2026 12:00:00 GMT', relevant: true }];

let captured = [], logs = [];
function makeService(reply) {
    const svc = new GoldGeminiService(cfgSvc);
    svc.logger = { log: (m) => logs.push(['log', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) };
    const client = new GoogleGenAI({ apiKey: 'fake-key' });
    client.models.generateContent = async (args) => {
        captured.push(args);
        return {
            text: typeof reply === 'function' ? reply() : reply,
            usageMetadata: { thoughtsTokenCount: 400, promptTokenCount: 6000, candidatesTokenCount: 220 },
            candidates: [{ finishReason: 'STOP' }],
        };
    };
    svc.client = client;
    return svc;
}

const goodProposal = {
    action: 'TRADE', order_type: 'BUY_LIMIT',
    entry: 3995, sl: 3992, tp1: 4001, tp2: 4004,   // risk 3 (~1.5×ATR) · reward 6 → R:R 2.0
    size: 'half', confidence: 7, playbook_ref: 'scalp #1',
    key_levels: 'Asian low 3992 · เลขกลม 4000',
    risk_note_th: 'ใกล้เลขกลม 4000', reason_th: 'sweep ใต้ Asian low แล้วดีดกลับ (scalp #1) — TA รอแท่งปิดยืนยันจึงพลาด',
    news_risk_th: 'CPI 19:30 ไทย', invalidation_th: 'ปิดต่ำกว่า 3985',
};

// automate ปลอม — เรียกเฉพาะ private helper ที่ทดสอบ
function fakeAuto(overrides = {}, tick = { bid: 4001, ask: 4001.2, at: Date.now() }) {
    const o = Object.create(GoldAutomateService.prototype);
    o.logger = { log() { }, warn() { }, error() { } };
    o.overrides = new Map();
    o.configService = { get: (k, d) => (overrides[k] !== undefined ? overrides[k] : d) };
    o.instruments = { active: XAUUSD_PROFILE, cachedSymbolId: () => 41 };
    o.activity = { push() { } };
    // ticks เป็น Map ต่อตราสาร (key = instrument key) แทน field เดี่ยวแบบเดิม
    o.ticks = new Map();
    if (tick) o.ticks.set(XAUUSD_PROFILE.key, tick);
    return o;
}

(async () => {
    console.log('\n=== 1. propose(): prompt โหมด lead ===');
    captured = []; logs = [];
    let svc = makeService(JSON.stringify(goodProposal));
    const out = await svc.propose('scalp', series, runtime, { profile: XAUUSD_PROFILE, news, now: new Date(NOW) });
    const req = captured[0] || {};
    const sys = String(req.config?.systemInstruction || '');
    const usr = String(req.contents || '');

    t('เรียก generateContent ครั้งเดียว', captured.length === 1);
    t('ใช้ PROPOSAL_SCHEMA (มี action/order_type/playbook_ref)',
        ['action', 'order_type', 'playbook_ref'].every((k) => k in (req.config?.responseJsonSchema?.properties || {})));
    t('system: บอกว่าเป็น "นักวิเคราะห์หลัก" ไม่ใช่ผู้ตรวจ', sys.includes('นักวิเคราะห์หลัก'));
    t('system: ตั้ง NO_TRADE เป็นค่าตั้งต้น', sys.includes('ค่าตั้งต้นคือ **NO_TRADE**'));
    t('system: บังคับอธิบายว่าทำไม TA พลาด', sys.includes('ทำไม TA ถึงพลาดไม้นี้'));
    t('system: ห้าม market order', sys.includes('ห้าม market order'));
    t('system: จำกัดขนาดไม้ไม่เกินครึ่ง', sys.includes('ไม่เกินครึ่ง'));
    t('system: มี playbook ครบทุกข้อของโหมด',
        XAUUSD_PROFILE.modes.scalp.playbook.every((p) => sys.includes(p.slice(0, 40))));
    t('system: ระบุ R:R ขั้นต่ำของโหมด', sys.includes(`R:R ขั้นต่ำที่ TP1: ${XAUUSD_PROFILE.modes.scalp.rrMin}:1`));
    t('system: เตือนเลขกลมของตราสาร', sys.includes(String(XAUUSD_PROFILE.round.step)));
    t('user: บอกว่า TA ไม่เจอ setup', usr.includes('TA ไม่เจอ setup'));
    t('user: มีบล็อกข้อมูลราคา + ระดับที่คำนวณให้ + ตัวประกอบ + ข่าว',
        usr.includes('## ข้อมูลราคา') && usr.includes('## ระดับที่คำนวณให้') && usr.includes('## ตัวประกอบ') && usr.includes('## ข่าว'));
    t('user: ไม่มีบล็อก "ไม้ที่ TA เสนอมา"', !usr.includes('ไม้ที่ระบบกฎ (TA) เสนอมา'));
    t('parse: คืนข้อเสนอครบ', out && out.action === 'TRADE' && out.entry === 3995 && out.playbook_ref === 'scalp #1');

    console.log('\n=== 2. propose(): คำตอบผิดรูปแบบ = null (ไม่มีไม้) ===');
    const bad = async (name, reply) => {
        logs = [];
        const s = makeService(reply);
        const r = await s.propose('scalp', series, runtime, { profile: XAUUSD_PROFILE, news: [], now: new Date(NOW) });
        t(name, r === null);
    };
    await bad('JSON พัง → null', 'ไม่ใช่ json');
    await bad('action ไม่รู้จัก → null', JSON.stringify({ ...goodProposal, action: 'MAYBE' }));
    await bad('TRADE แต่ order_type = NONE → null', JSON.stringify({ ...goodProposal, order_type: 'NONE' }));
    await bad('TRADE แต่ entry เป็น null → null', JSON.stringify({ ...goodProposal, entry: null }));
    await bad('TRADE แต่ไม่อ้าง playbook → null', JSON.stringify({ ...goodProposal, playbook_ref: '' }));
    await bad('TRADE แต่ราคาติดลบ → null', JSON.stringify({ ...goodProposal, sl: -5 }));

    logs = [];
    const noTrade = await makeService(JSON.stringify({ ...goodProposal, action: 'NO_TRADE', order_type: 'NONE', entry: null, sl: null, tp1: null, tp2: null }))
        .propose('scalp', series, runtime, { profile: XAUUSD_PROFILE, news: [], now: new Date(NOW) });
    t('NO_TRADE → คืน object ที่ action=NO_TRADE (ไม่ใช่ null)', noTrade && noTrade.action === 'NO_TRADE' && noTrade.entry === null);

    const noKey = new GoldGeminiService({ get: (k, d) => (k === 'GEMINI_API_KEY' ? '' : d) });
    noKey.logger = { log() { }, warn() { }, error() { } };
    t('ไม่มีคีย์ → null (ไม่ throw)',
        (await noKey.propose('scalp', series, runtime, { profile: XAUUSD_PROFILE, news: [] })) === null);

    const boom = makeService(() => { throw new Error('network down'); });
    t('API พัง → null (ไม่ throw)',
        (await boom.propose('scalp', series, runtime, { profile: XAUUSD_PROFILE, news: [], now: new Date(NOW) })) === null);

    console.log('\n=== 3. applyProposal(): ด่านกันไม้อันตราย ===');
    const a = fakeAuto();
    const P = (o) => ({ ...goodProposal, ...o });
    const ok = a.applyProposal(P({}), 1.5, null, XAUUSD_PROFILE, series, 'scalp');

    t('ไม้ที่ดี → ผ่านเป็น BUY_LIMIT', ok.order_type === 'BUY_LIMIT' && ok.entry === 3995);
    t('คำนวณ R:R ให้เอง ไม่เชื่อ AI', ok.rr_tp1 === 2);
    t('ติดป้ายว่ามาจาก AI ไม่ใช่ TA', ok.reason.startsWith('AI หาไม้เอง (lead)') && ok.analysis_summary_th.includes('🤖'));
    t('เก็บ playbook_ref ที่ AI อ้าง', ok.playbook_ref === 'scalp #1');
    t('ตั้งวันหมดอายุออเดอร์ให้', typeof ok.valid_until_utc === 'string' && ok.valid_until_utc.endsWith('Z'));

    t('ไม่มีข้อเสนอ (null) → NO_TRADE', a.applyProposal(null, 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');
    t('AI ตอบ NO_TRADE → NO_TRADE',
        a.applyProposal(P({ action: 'NO_TRADE' }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');

    // ขนาดไม้
    t('ขอ full → ถูกลดเหลือ half (ไม่มี TA ยืนยัน)',
        a.applyProposal(P({ size: 'full' }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').size === 'half');
    t('ขอ quarter → ยังเป็น quarter (ลดเองได้)',
        a.applyProposal(P({ size: 'quarter' }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').size === 'quarter');
    t('sizeCap=quarter ทับ half ที่ AI ขอ',
        a.applyProposal(P({ size: 'half' }), 1.5, 'quarter', XAUUSD_PROFILE, series, 'scalp').size === 'quarter');

    // confidence
    t('confidence 10 ถูกตัดที่เพดานของ TA (8)',
        a.applyProposal(P({ confidence: 10 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').confidence === 8);

    // ทิศทาง/ระดับผิด
    t('SL ผิดฝั่ง (BUY แต่ SL > entry) → ทิ้งไม้',
        a.applyProposal(P({ sl: 3999 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');
    t('TP ผิดฝั่ง (BUY แต่ TP < entry) → ทิ้งไม้',
        a.applyProposal(P({ tp1: 3991 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');
    t('R:R ต่ำกว่าขั้นต่ำ → ทิ้งไม้',
        a.applyProposal(P({ tp1: 3998 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');

    // SL เทียบ ATR
    const atr = series.xauusd_5m[series.xauusd_5m.length - 1].atr14;
    t(`SL แคบกว่า 0.3×ATR (${atr.toFixed(2)}) → ทิ้งไม้`,
        a.applyProposal(P({ sl: 3995 - atr * 0.1, tp1: 3995 + atr * 5 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');
    t('SL กว้างเกิน 3×ATR → ทิ้งไม้',
        a.applyProposal(P({ sl: 3995 - atr * 5, tp1: 3995 + atr * 20 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');

    // entry เทียบราคาตลาด (bid 4001 / ask 4001.2)
    t('BUY_LIMIT ที่สูงกว่าราคาตลาด → ทิ้งไม้',
        a.applyProposal(P({ entry: 4010, sl: 4007.5, tp1: 4015 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');
    t('BUY_STOP ที่สูงกว่าราคาตลาด → ผ่าน',
        a.applyProposal(P({ order_type: 'BUY_STOP', entry: 4004, sl: 4001.5, tp1: 4009 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'BUY_STOP');
    t('SELL_LIMIT ที่ต่ำกว่าราคาตลาด → ทิ้งไม้',
        a.applyProposal(P({ order_type: 'SELL_LIMIT', entry: 3990, sl: 3992.5, tp1: 3985 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');
    t('SELL_STOP ที่ต่ำกว่าราคาตลาด → ผ่าน',
        a.applyProposal(P({ order_type: 'SELL_STOP', entry: 3998, sl: 4000.5, tp1: 3993 }), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'SELL_STOP');
    // เปลี่ยนสัญญาโดยตั้งใจ (2026-08-27): เดิม "ไม่มีราคาสด = ข้ามด่านไปเลย"
    // = ด่านปิดตัวเองเงียบ ๆ ตอน feed ตาย ซึ่งเป็นตอนที่ต้องการมันที่สุด
    // ไม้ lead ไม่มี TA ยืนยันอยู่แล้ว ตรวจฝั่งไม่ได้ = ทิ้งไม้
    t('ไม่มีราคาตลาด → ทิ้งไม้ (ตรวจฝั่งออเดอร์ไม่ได้)',
        fakeAuto({}, null).applyProposal(P({}), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');
    t('ราคาตลาดค้างเกิน 90 วิ → ทิ้งไม้',
        fakeAuto({}, { bid: 4000, ask: 4000.5, at: Date.now() - 5 * 60_000 })
            .applyProposal(P({}), 1.5, null, XAUUSD_PROFILE, series, 'scalp').order_type === 'NO_TRADE');

    console.log('\n=== 4. aiMode(): off | assist | lead ===');
    const mode = (o) => {
        const x = fakeAuto(o);
        x.goldGeminiService = { config: { has_key: true }, apiKey: 'k' };
        return x.aiMode();
    };
    t('ไม่ตั้งอะไร → off', mode({}) === 'off');
    t('GOLD_AI_ASSIST=true (ของเดิม) → assist', mode({ GOLD_AI_ASSIST: 'true' }) === 'assist');
    t('GOLD_AI_MODE=lead → lead', mode({ GOLD_AI_MODE: 'lead' }) === 'lead');
    t('GOLD_AI_MODE=off ทับ GOLD_AI_ASSIST=true', mode({ GOLD_AI_MODE: 'off', GOLD_AI_ASSIST: 'true' }) === 'off');
    t('ค่ามั่ว → ตกไปที่ GOLD_AI_ASSIST', mode({ GOLD_AI_MODE: 'ลุยเลย', GOLD_AI_ASSIST: 'true' }) === 'assist');
    {
        const x = fakeAuto({ GOLD_AI_MODE: 'lead' });
        x.goldGeminiService = { config: { has_key: false }, apiKey: '' };
        t('lead แต่ไม่มีคีย์ → off (ไม่เงียบ ๆ ปล่อยผ่าน)', x.aiMode() === 'off');
    }

    console.log('\n=== 5. โควตา AI ต่อวัน — ชนเพดานแล้วต้องไม่หยุดทำงาน ===');
    {
        const q = makeService(JSON.stringify(goodProposal));
        const D = new Date(Date.UTC(2026, 7, 26, 10, 0));
        t('เริ่มต้น used = 0', q.usage(10, D).used === 0);
        t('remaining = เพดาน', q.usage(10, D).remaining === 10);
        for (let i = 0; i < 10; i++) q.tryConsume(10, D);
        t('ยิงครบ 10 → used = 10', q.usage(10, D).used === 10);
        t('เต็มแล้ว remaining = 0', q.usage(10, D).remaining === 0);
        t('ครั้งที่ 11 → tryConsume คืน false (ผู้เรียกต้องข้าม AI)', q.tryConsume(10, D) === false);
        t('ถูกปฏิเสธแล้วไม่นับเพิ่ม', q.usage(10, D).used === 10);

        // ตั้งเพดานสูงขึ้นระหว่างวัน = ยิงต่อได้ทันที
        t('ขยายเพดานเป็น 15 → ยิงต่อได้', q.tryConsume(15, D) === true);
        t('used = 11 หลังขยายเพดาน', q.usage(15, D).used === 11);

        // ข้ามวัน UTC = เริ่มนับใหม่เอง
        const D2 = new Date(Date.UTC(2026, 7, 27, 0, 5));
        t('ข้ามวัน UTC → used รีเซ็ตเป็น 0 เอง', q.usage(10, D2).used === 0);
        t('ข้ามวันแล้วยิงได้อีก', q.tryConsume(10, D2) === true);

        // ปุ่มรีเซ็ต
        for (let i = 0; i < 9; i++) q.tryConsume(10, D2);
        t('ยิงจนเต็มอีกรอบ', q.usage(10, D2).remaining === 0);
        const before = q.resetUsage(D2);
        t('resetUsage คืนจำนวนเดิมที่ใช้ไป', before === 10);
        t('รีเซ็ตแล้ว used = 0', q.usage(10, D2).used === 0);
        t('รีเซ็ตแล้วยิงได้ทันที', q.tryConsume(10, D2) === true);

        // 0 = ไม่จำกัด
        const q2 = makeService(JSON.stringify(goodProposal));
        let allOk = true;
        for (let i = 0; i < 50; i++) allOk = allOk && q2.tryConsume(0, D);
        t('เพดาน 0 = ไม่จำกัด (ยิง 50 ครั้งผ่านหมด)', allOk);
        t('ไม่จำกัด → remaining = null', q2.usage(0, D).remaining === null);

        // refund เมื่อยังไม่ได้ยิงจริง
        const q3 = makeService(JSON.stringify(goodProposal));
        q3.tryConsume(10, D); q3.refund();
        t('refund คืนโควตาได้', q3.usage(10, D).used === 0);
    }

    console.log('\n=== 6. ประตู near-miss — ถาม AI เฉพาะรอบที่คุ้ม ===');
    {
        const { classifyNoTrade, NEAR_MISS_RULES } = require(path.join(OUT, 'analysis/gold-ta.service'));
        // ข้อความจริงที่ดึงมาจาก archive (ไม่ได้แต่งขึ้น)
        const REAL = [
            ['ยังไม่มีแท่ง 15m ปิดนอกกรอบเอเชีย — รอ break ที่ยืนยันด้วยแท่งปิดก่อน (กัน false breakout)', 'await-confirm-bar'],
            ['SL โครงสร้างกว้าง 1.9×ATR(1d) เกินเกณฑ์ 1.5 — ไม้นี้ risk ไม่คุ้ม', 'sl-slightly-wide'],
            ['ราคาอยู่ในโซน pullback แต่ยังไม่มีแท่งกลับตัวยืนยัน (swing #2) — รอ', 'await-reversal-bar'],
            ['ทิศ 4H (ขึ้น) ขัดกับ regime 1d (ราคาใต้ EMA200(1d) 4306.48) — ช่วงเปลี่ยนผ่าน ไม่เทรด', 'tf-regime-conflict'],
            ['เป้าที่สมจริง (หลบเลขกลม/แม่เหล็ก) ให้ R:R 0.78 < เกณฑ์ 2 — ไม่คุ้ม (playbook swing #2)', 'rr-just-below'],
            ['มีแท่งปิดนอกกรอบแต่ RVOL 1.18 < 1.2 — break ไร้แรง volume ไม่หนุน (ORB evidence)', 'rvol-just-below'],
            ['ราคาเลยโซน pullback ไปแล้ว 103.22 (1.1×ATR) — โครงสร้างเสีย รอ leg ใหม่', 'past-zone'],
        ];
        for (const [reason, id] of REAL) {
            const c = classifyNoTrade(reason);
            t(`เฉียด: ${id}`, c.near_miss === true && c.near_miss_rule === id, JSON.stringify(c));
        }
        const NOT_NEAR = [
            'ไม่มี setup sweep/break-retest ที่เข้าเกณฑ์ในรอบนี้ — NO-TRADE ตามวินัย scalp',
            'กรอบเอเชียวันนี้ยังไม่ครบ (ก่อน 14:00 ไทย) — รอ London (intraday #1)',
            'ราคาวิ่งหนีขอบกรอบไปไกลแล้ว — เป้า 1.5×กรอบใกล้หมด ไม่ไล่',
            'ราคากลับเข้ากรอบลึกหลังทะลุ (fake breakout) — ยกเลิก setup ตามวินัย',
            'ข้อมูล 4h/1d/1h ไม่พอ',
        ];
        for (const r of NOT_NEAR) {
            const c = classifyNoTrade(r);
            t(`ไม่เฉียด: ${r.slice(0, 38)}…`, c.near_miss === false && c.near_miss_rule === null);
        }
        t('ปิดกฎด้วย enabled:false ได้', (() => {
            const rule = NEAR_MISS_RULES.find(x => x.id === 'rvol-just-below');
            rule.enabled = false;
            const off = classifyNoTrade('มีแท่งปิดนอกกรอบแต่ RVOL 1.18 < 1.2 — break ไร้แรง');
            rule.enabled = undefined;
            const on = classifyNoTrade('มีแท่งปิดนอกกรอบแต่ RVOL 1.18 < 1.2 — break ไร้แรง');
            return off.near_miss === false && on.near_miss === true;
        })());
        t('ทุกกฎมี id / why_th / match ครบ',
            NEAR_MISS_RULES.every(r => r.id && r.why_th && r.match instanceof RegExp));
        t('id ไม่ซ้ำกัน', new Set(NEAR_MISS_RULES.map(r => r.id)).size === NEAR_MISS_RULES.length);

        // ประตูตัดสินถูกตามค่า GOLD_AI_GATE
        const gate = (g, dec) => {
            const x = fakeAuto(g ? { GOLD_AI_GATE: g } : {});
            x.goldGeminiService = { config: { has_key: true }, apiKey: 'k' };
            return x.shouldAskAiForSetup(dec).ask;
        };
        const near = { order_type: 'NO_TRADE', near_miss: true, near_miss_rule: 'rvol-just-below' };
        const none = { order_type: 'NO_TRADE', near_miss: false };
        t('ค่าตั้งต้น = near_miss', fakeAuto({}).aiGate() === 'near_miss');
        t('ค่ามั่ว → ตกกลับเป็น near_miss', fakeAuto({ GOLD_AI_GATE: 'ลุย' }).aiGate() === 'near_miss');
        t('near_miss: รอบเฉียด → ถาม', gate('near_miss', near) === true);
        t('near_miss: รอบไม่มีอะไร → ไม่ถาม', gate('near_miss', none) === false);
        t('always: ถามหมดแม้ไม่มีอะไร', gate('always', none) === true);
        t('setup_only: ไม่ถามแม้เฉียด', gate('setup_only', near) === false);
    }

    console.log('\n=== 7. ตราสารอื่นใช้ได้ (EURUSD) ===');
    captured = [];
    const eu = makeService(JSON.stringify(goodProposal));
    await eu.propose('intraday', null, runtime, { profile: EURUSD_PROFILE, news: [], now: new Date(NOW) });
    const eusys = String(captured[0]?.config?.systemInstruction || '');
    t('system ใช้ persona/ตราสารของ EURUSD', eusys.includes('EURUSD') && !eusys.includes('XAUUSD'));
    t('system ระบุทศนิยม 5 ตำแหน่ง', eusys.includes('ทศนิยม 5 ตำแหน่ง'));
    t('system ใช้ playbook ของ intraday EURUSD',
        EURUSD_PROFILE.modes.intraday.playbook.every((p) => eusys.includes(p.slice(0, 40))));

    console.log(`\n${fail === 0 ? '✅ AI LEAD ผ่านหมด' : '❌ AI LEAD พัง'} ${pass}/${pass + fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
