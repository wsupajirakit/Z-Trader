/**
 * เนื้อหาเฉพาะคู่เงิน (forex) — โหมด/playbook/session map/reading guide/ความรู้สำหรับ prompt
 * โครงเดียวกับ gold-modes.ts เพื่อให้ TA engine + builder + prompt ใช้ร่วมกันได้
 *
 * หลักการเขียน playbook: ใช้ลำดับข้อเดียวกับทอง (#1 โครงหลัก · #2 setup เข้า · …)
 * เพราะ TA engine อ้างอิง playbook_ref เป็น "<mode> #<n>" ตามลำดับเดิม
 *   scalp    #1 = liquidity sweep · #2 = break-retest กรอบเอเชีย
 *   intraday #1 = วงจร 3 session · #2 = London break (retest) · #5 = เช็คทิศกับตัวประกอบ
 *   swing    #1 = trend filter 4H · #2 = confirmation/ขนาดครึ่ง
 *   position #1 = โครง 1W · #2 = ทยอยไม้ที่ pullback
 */
import { GoldMode } from '../data/gold-data.service';
import { GoldModeSpec } from './gold-modes';
import type { InstrumentBrief } from './instruments';

export interface FxContent {
    modes: Record<GoldMode, GoldModeSpec>;
    companionBrief_th: string;
    sessionMap: Array<[string, string]>;
    readingGuide: (priceSource: string) => Array<[string, string]>;
    brief: InstrumentBrief;
}

/** feed ข่าว forex เพิ่มจากชุดทั่วไป (ดึงแบบ allSettled — feed ล่มไม่ทำให้รอบพัง) */
export const FX_NEWS_FEEDS = [
    { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
    { name: 'Investing.com Forex', url: 'https://www.investing.com/rss/news_1.rss' },
    // ForexLive/investingLive ปิด feed ไปแล้ว (403 ทั้ง 2 โดเมน) — ใช้ MarketPulse (OANDA) แทน
    { name: 'MarketPulse (OANDA)', url: 'https://www.marketpulse.com/feed/' },
];

const FX_SESSION_MAP = (pairNote: string): Array<[string, string]> => [
    [
        'Asia/Tokyo',
        '06:00–14:00 ไทย (19:00–03:00 ET) — Tokyo fix 09:55 JST (07:55 ไทย) · คู่ที่ไม่มี JPY มักเงียบ สร้างกรอบวัน (Asian range)',
    ],
    [
        'Frankfurt/London open',
        '13:00/14:00 ไทย (02:00/03:00 ET) — แรงขยับแรกของวัน break/reject กรอบเอเชีย · ข้อมูลยุโรป/UK ออก 07:00–10:00 London',
    ],
    [
        'London–NY overlap',
        '19:00–23:00 ไทย (08:00–12:00 ET) — volume/volatility สูงสุดของวัน · ข้อมูล US 08:30 ET · NY option cut 10:00 ET (strike ใหญ่ดึงราคา)',
    ],
    ['London fix', '22:00 ไทย (11:00 ET / 16:00 London) — flow เดือน/ไตรมาสปลายเดือนแกว่งแรงผิดปกติ'],
    ['Dead zone', 'หลัง 12:00 ET ถึง Tokyo เปิด — สภาพคล่องบาง spread ถ่างช่วง rollover 17:00 ET · งดไม้ใหม่'],
    ['Daily range', pairNote],
];

const FX_READING_GUIDE =
    (corr: string, spreadNote: string) =>
    (priceSource: string): Array<[string, string]> => [
        [
            'Order Semantics',
            'BUY LIMIT = ตั้งซื้อต่ำกว่าราคาปัจจุบัน (รอย่อ) · BUY STOP = ตั้งซื้อเหนือราคาปัจจุบัน (รอทะลุ) · SELL LIMIT = ตั้งขายเหนือราคาปัจจุบัน (รอเด้ง) · SELL STOP = ตั้งขายต่ำกว่าราคาปัจจุบัน (รอหลุด)',
        ],
        [
            'Volume Caveat',
            'Volume ทุกไฟล์ = tick volume ของ FX/CFD — CMF/OBV/RVOL ใช้เปรียบเทียบ relative เท่านั้น (forex ไม่มี volume กลาง)',
        ],
        [
            'Multi-TF Rule',
            'TF ใหญ่บอกทิศ TF เล็กบอกจังหวะ — ถ้าขัดกันให้ลดขนาดหรือ NO-TRADE · สัญญาณจากแท่งที่ยังไม่ปิด (Is_Closed_Bar=False) ห้ามใช้ยืนยัน',
        ],
        ['Correlation Playbook', corr],
        [
            'Session',
            'Forex เปิด 24/5: อาทิตย์ 17:05 ET → ศุกร์ 16:55 ET · ไม่มีพักรายวันแต่ rollover 17:00 ET spread ถ่าง 2–5 เท่า · สภาพคล่องบางสุดหลังปิด NY ถึง Tokyo เปิด',
        ],
        [
            'Spread Note',
            `ราคาคู่เงินหลักมาจาก ${priceSource} — feed เดียวกับบัญชีที่ยิงออเดอร์จริง ตั้งระดับด้วยข้อมูลชุดนี้เสมอ · ${spreadNote} · ตัวประกอบมาจาก Yahoo Finance (ต่างแหล่งได้ ใช้ดูทิศเท่านั้น)`,
        ],
    ];

// ======================= EURUSD =======================

const EURUSD_MODES: Record<GoldMode, GoldModeSpec> = {
    scalp: {
        ttl: 60,
        news: 10,
        rrMin: 1.5,
        horizon: 'เข้า-ออกภายใน 1–4 ชั่วโมง',
        tfRoles: '5m = TF สั่งการ (entry/SL) · 15m = TF บริบท (ทิศ/liquidity pools)',
        slGuide:
            'SL เลยจุด sweep + 1–2 pips spread · หรือ 0.5–0.8 × ATR14(5m) · ห้ามวางตรง big figure/half figure (x.xx00 / x.xx50) พอดี',
        playbook: [
            'Setup หลัก A — Liquidity Sweep: ราคาแทงทะลุ high/low ของ session ก่อนหน้า หรือระดับ 00/50 แล้วปิดกลับเข้ากรอบทันที (sweep + displacement: แท่งกว้าง ≥1.1×ATR · ปิดสวนกลับแรง · RVOL ≥1.3) → เข้าที่ retest ของแนวที่เพิ่งทวงคืน · เป้า = pool ฝั่งตรงข้าม · SL เลย sweep 0.5–0.8×ATR',
            'Setup หลัก B — Break-Retest กรอบเอเชีย: London open (14:00 ไทย / 03:00 ET) ราคาทะลุกรอบ Asian range (ปกติ 20–40 pips) แล้วย่อกลับมา retest ขอบ → เข้าตามทิศทะลุ · กรอบแคบผิดปกติ (<0.5×ATR 1h) = breakout เชื่อไม่ได้ รอ',
            'หน้าต่างทำเงิน: London open 14:00–16:00 ไทย และ overlap 19:00–23:00 ไทย (08:00–12:00 ET) — นอกหน้าต่างนี้ spread กว้าง สัญญาณเชื่อไม่ได้ = NO-TRADE',
            'เลขกลม: EURUSD หยุด/เด้งที่ 00 และ 50 pips (เช่น 1.0800 / 1.0850) เพราะ option strike และ order สถาบันกระจุก — TP แรกอย่าข้าม figure ถัดไป · entry ใกล้ figure ให้รอ sweep ก่อนไม่ดักหน้า · NY option cut 10:00 ET strike ใหญ่ "ดึง" ราคา',
            'เป้าสมจริงต่อไม้: 8–15 pips · ข่าว 08:30 ET (US) และ ECB 08:15 ET (พฤหัสทุก 6 สัปดาห์) = NO-TRADE ±30 นาที · PMI flash ยุโรป 03:15–04:00 ET ทำให้ London open ผันผวนกว่าปกติ',
        ],
        sets: [
            { symbol: 'EURUSD', tf: '5m', nBars: 500 },
            { symbol: 'EURUSD', tf: '15m', nBars: 400 },
            { symbol: 'DXY', tf: '15m', nBars: 300 },
            { symbol: 'US10Y', tf: '15m', nBars: 300 },
            { symbol: 'GBPUSD', tf: '15m', nBars: 300 },
        ],
    },
    intraday: {
        ttl: 120,
        news: 15,
        rrMin: 1.8,
        horizon: 'ถือหลักชั่วโมงถึงข้ามวัน (1–4 ชม. ขึ้นไป)',
        tfRoles: '15m/30m = จังหวะเข้า · 1h = TF สั่งการทิศ',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) หรือใต้/เหนือขอบ Asian range ฝั่งตรงข้าม · หลบ 00/50',
        playbook: [
            'เกมหลักคือวงจร 3 session: เอเชีย (06:00–14:00 ไทย) สร้างกรอบวัน 20–40 pips → London (14:00 ไทย) break หรือ reject กรอบ → ขี่ต่อเข้า NY (19:30 ไทย) — เป้ามาตรฐาน 1.5–2 เท่าของความกว้างกรอบ · วันปกติ EURUSD วิ่ง 60–90 pips',
            'Setup A — London break: ทะลุ Asian high/low + ปิดแท่ง 15m/30m นอกกรอบ + RVOL ≥1.2 + retest ไม่หลุดกลับ → เข้าที่ retest ขอบกรอบ (LIMIT)',
            'Setup B — London reject (fade): แทงทะลุกรอบแล้วปิดกลับใน (fake breakout — EURUSD ทำบ่อยช่วง 03:00–04:00 ET ก่อน PMI) → เล่นสวนไปขอบกรอบฝั่งตรงข้าม ครึ่งไม้ของ Setup A',
            'NY 08:30 ET data คือจุดเร่ง/กลับทางกลางวัน — ถือผ่านได้เฉพาะไม้ที่มีกำไร buffer แล้ว ไม้ใหม่รอหลังข่าว 15–30 นาที · 10:00 ET option cut มักดึงราคากลับหา strike ใหญ่ก่อนปล่อย · FOMC/ECB วัน = ห้ามเปิดก่อนประกาศ',
            'ทิศระหว่างวันเช็คกับ DXY 1h เสมอ (EUR = 57% ของ DXY จึงแทบเป็นกระจก) + US10Y: yields US พุ่ง = USD แข็ง กด EURUSD — ถ้า EURUSD ขึ้นพร้อม DXY ขึ้น = ขาอ่อน อย่าไล่',
        ],
        sets: [
            { symbol: 'EURUSD', tf: '15m', nBars: 400 },
            { symbol: 'EURUSD', tf: '30m', nBars: 350 },
            { symbol: 'EURUSD', tf: '1h', nBars: 400 },
            { symbol: 'DXY', tf: '1h', nBars: 300 },
            { symbol: 'US10Y', tf: '1h', nBars: 300 },
            { symbol: 'VIX', tf: '1h', nBars: 300 },
            { symbol: 'SPY', tf: '1h', nBars: 300 },
            { symbol: 'GBPUSD', tf: '1h', nBars: 300 },
            { symbol: 'USDCHF', tf: '1h', nBars: 300 },
        ],
    },
    swing: {
        ttl: 300,
        news: 25,
        rrMin: 2.0,
        horizon: 'ถือหลายวันถึงหลายสัปดาห์',
        tfRoles: '1h = จังหวะเข้า · 4h = โครงสร้าง · 1d = TF สั่งการทิศใหญ่',
        slGuide:
            'SL ใต้/เหนือ swing low/high ของ pullback ที่ใช้เข้าเสมอ (ไม่ใช่ ATR ลอย ๆ ไม่ใช่ figure) · ตรวจว่ากว้าง ≈ 1.0–1.5 × ATR14(1d) (~60–100 pips)',
        playbook: [
            'โครงหลัก (trend-pullback): ใช้ 4H EMA50 vs EMA200 เป็น trend filter (50>200 = เล่นฝั่ง BUY เท่านั้น) → รอ pullback เข้าโซน: EMA20/50 4H · Fib 38.2/50/61.8 ของขาล่าสุด (61.8–78.6 = OTE ให้ RR ดีสุด) · หรือ figure เก่าที่กลายเป็นแนวรับ',
            'เข้าเมื่อมี confirmation เท่านั้น: แท่งกลับตัว (hammer/engulfing) บน 1H–4H · RSI divergence · หรือ break เส้นเทรนด์ย่อยของ pullback — ไม่มี confirmation = ตั้ง LIMIT ที่โซนได้แต่ขนาดครึ่งเดียว',
            'Macro overlay ก่อนสรุปทิศ: ตัวขับ EURUSD ระดับสัปดาห์คือ "ส่วนต่างดอกเบี้ย" Fed vs ECB (US2Y − DE2Y) และ DXY (corr ≈ −0.95) · ECB ตัดสินก่อน Fed = ยูโรอ่อน · ราคาพลังงานแพง = ยุโรปเสียดุลการค้า ยูโรอ่อน · risk-off ใหญ่ = USD แข็ง ยูโรอ่อน · positioning CFTC สุดขั้วฝั่งเดียว = เสี่ยง squeeze',
            'ระดับที่เป็นแม่เหล็ก: weekly open · prev week high/low · figure ใหญ่ทุก 100 pips (1.05/1.10/1.15) · monthly option barrier — ใช้เป็นเป้า TP และจุดคาด reaction',
            'GBPUSD/USDCHF ใช้คอนเฟิร์มเผ่า: EURUSD ขึ้นโดย GBPUSD ตามและ USDCHF ลง = USD อ่อนทั้งกระดานของจริง · EURUSD ขึ้นเดี่ยว = เป็นเรื่องยูโร (ECB) เปราะกว่า',
        ],
        sets: [
            { symbol: 'EURUSD', tf: '1h', nBars: 400 },
            { symbol: 'EURUSD', tf: '4h', nBars: 360 },
            { symbol: 'EURUSD', tf: '1d', nBars: 300 },
            { symbol: 'DXY', tf: '4h', nBars: 300 },
            { symbol: 'DXY', tf: '1d', nBars: 300 },
            { symbol: 'US10Y', tf: '1d', nBars: 300 },
            { symbol: 'VIX', tf: '1d', nBars: 300 },
            { symbol: 'SPY', tf: '1d', nBars: 300 },
            { symbol: 'GBPUSD', tf: '1d', nBars: 300 },
            { symbol: 'USDCHF', tf: '1d', nBars: 300 },
        ],
    },
    position: {
        ttl: 900,
        news: 25,
        rrMin: 2.5,
        horizon: 'ถือหลายสัปดาห์ถึงหลายเดือน',
        tfRoles: '1d = จังหวะสะสม · 1w = TF สั่งการเทรนด์หลัก',
        slGuide:
            'SL ใต้โครงสร้างรายสัปดาห์ (swing low 1w · ≈1.0–1.5 × ATR14(1w) ~150–250 pips) · ทยอยเข้า 3-4 ไม้ไม่ยิงครั้งเดียว',
        playbook: [
            'ทิศหลักมาจากโครงสร้าง 1W (แท่งปิดรายสัปดาห์เหนือ/ใต้ EMA20W) · เทรนด์ระดับเดือนของ EURUSD เดินตาม "วงจรนโยบาย" — ใครเริ่มลดดอกเบี้ยก่อน/เร็วกว่า สกุลนั้นอ่อน · ส่วนต่าง yield 2 ปี US−DE คือเข็มทิศ',
            'เข้าเป็นไม้ ๆ ที่ pullback รายวันลึก (Fib 50–61.8 ของขา 1W) — ไม้แรกเมื่อแตะโซน ไม้ถัดไปเมื่อมีแท่งกลับตัวรายวัน/รายสัปดาห์ยืนยัน',
            'ตัวนำ: DXY รายสัปดาห์ทำ new high แต่ EURUSD ไม่ทำ new low = bullish divergence (มีคนรับยูโร) · USDCHF ไม่ยืนยัน = USD อ่อนไม่ทั่วกระดาน ระวัง',
            'โหมดนี้ event เดี่ยวไม่เปลี่ยนทิศ — สิ่งที่เปลี่ยนทิศคือจุดกลับของ cycle Fed/ECB, วิกฤตพลังงานยุโรป, หรือ shock การเมือง EU (เลือกตั้งฝรั่งเศส/อิตาลี) → ทบทวน thesis ทุกครั้ง',
        ],
        sets: [
            { symbol: 'EURUSD', tf: '1d', nBars: 300 },
            { symbol: 'EURUSD', tf: '1w', nBars: 200 },
            { symbol: 'DXY', tf: '1w', nBars: 200 },
            { symbol: 'US10Y', tf: '1w', nBars: 200 },
            { symbol: 'GBPUSD', tf: '1w', nBars: 200 },
            { symbol: 'USDCHF', tf: '1w', nBars: 200 },
        ],
    },
};

const EURUSD_BRIEF: InstrumentBrief = {
    persona_th:
        'คุณคือหัวหน้าโต๊ะ G10 FX ของธนาคารเพื่อการลงทุน เทรด EURUSD มา 15 ปี ผ่านวิกฤตยูโรโซน 2012, QE ของ ECB, ขา parity ปี 2022 — อ่าน flow/option strike/ส่วนต่างดอกเบี้ยขาด และเคารพความเสี่ยงเหนือทุกสิ่ง',
    drivers_th: [
        'ส่วนต่างดอกเบี้ย Fed vs ECB (US2Y − DE2Y) คือตัวขับหลักระดับสัปดาห์-เดือน · ตลาดเทรด "ความคาดหวัง" ของ cycle ไม่ใช่ตัวเลขปัจจุบัน',
        'DXY เป็นกระจกเงา (EUR = 57.6% ของตะกร้า) corr ≈ −0.95 — อ่าน DXY ให้ออกก่อนอ่านยูโร',
        'Risk sentiment: risk-off ใหญ่ = USD แข็ง (safe haven) ยูโรอ่อน · risk-on = EURUSD ขึ้นพร้อม SPY',
        'ข้อมูลยุโรป: PMI flash (03:15–04:00 ET), เงินเฟ้อ HICP, German IFO/ZEW, ECB ทุก 6 สัปดาห์ (พฤหัส 08:15 ET + แถลง 08:45 ET)',
        'ข้อมูล US 08:30 ET (NFP/CPI/PCE) และ FOMC 14:00 ET กระทบแรงเท่ากันเพราะ USD คือครึ่งหนึ่งของคู่',
        'ราคาพลังงาน: ยุโรปนำเข้าพลังงาน — น้ำมัน/ก๊าซแพง = ยูโรอ่อน (เห็นชัดปี 2022)',
    ],
    behaviour_th: [
        'ช่วงราคาปกติ 60–90 pips/วัน · spread 0.1–0.5 pip ช่วง London/NY แต่ถ่างช่วง rollover 17:00 ET และข่าว',
        'เลขกลม 00/50 (เช่น 1.0800/1.0850) = option strike และ order สถาบันกระจุก → ราคาหยุด/เด้ง/กวาด stop ตรงนี้ · NY option cut 10:00 ET strike ใหญ่ดึงราคาเหมือนแม่เหล็ก',
        'Asian range แคบ (20–40 pips) → London open break/reject · false breakout ช่วง 03:00–04:00 ET บ่อยมาก ต้องรอแท่งปิด + volume',
        'EURUSD เทรนด์ "ช้าแต่ยาว" ใน TF ใหญ่: ขาใหญ่วิ่งหลายร้อย pips หลายเดือน แต่ย่อกลับโซน EMA/Fib ซ้ำ ๆ ให้เข้าได้',
        'ปลายเดือน/ไตรมาส London fix 11:00 ET flow ปรับพอร์ตทำให้ราคาวิ่งผิดโครงสร้างชั่วคราว',
    ],
    sessions_th: [
        'Asia 06:00–14:00 ไทย: เงียบ สร้าง Asian range',
        'Frankfurt 13:00 ไทย / London 14:00 ไทย (02:00/03:00 ET): แรงขยับแรก break/reject กรอบเอเชีย · ข้อมูลยุโรปออกช่วงนี้',
        'London–NY overlap 19:00–23:00 ไทย (08:00–12:00 ET): volume สูงสุด · 08:30 ET ข่าว US · 10:00 ET option cut',
        'หลัง 12:00 ET: สภาพคล่องลด เทรนด์วันมักหยุด · rollover 17:00 ET spread ถ่าง',
        'ตลาด 24/5: อาทิตย์ 17:05 ET → ศุกร์ 16:55 ET',
    ],
    levels_th: [
        'SL ต้องอยู่พ้นโครงสร้าง (เลย sweep/swing) + 1–2 pips spread และไม่ทับ 00/50 — คุมเงินด้วย lot ไม่ใช่บีบ SL',
        'TP แรกไม่ข้าม figure/half-figure ถัดไป และไม่ข้าม prev day high/low · weekly open',
        'Entry ต้องตรงโครงสร้าง: retest ขอบกรอบ, แนวที่เพิ่งทวงคืน, Fib 50–61.8 ของ leg, EMA20/50 4H',
        'มูลค่า: 1 lot = €100,000 → 1 pip = $10 · SL 30 pips ที่ 0.1 lot = เสี่ยง $30',
    ],
    risks_th: [
        'False breakout London open — ต้องมีแท่ง 15m ปิดนอกกรอบ + RVOL ≥1.2',
        'ไล่ราคาหลัง 08:30 ET — รอ 15–30 นาที',
        'เทรดสวน DXY: EURUSD ขึ้นแต่ DXY ไม่ลง = ขาปลอม',
        'ลืม ECB/Fed วัน: ราคาวิ่ง 100+ pips ในนาทีเดียว SL โดนกวาดพร้อม slippage',
    ],
    events_th: [
        'ECB ทุก 6 สัปดาห์ พฤหัส 08:15 ET (แถลง 08:45 ET) · FOMC 14:00 ET',
        'US: NFP ศุกร์แรก, CPI กลางเดือน, PCE ปลายเดือน, jobless พฤหัส — 08:30 ET ทั้งหมด',
        'ยุโรป: PMI flash ~วันที่ 23 ของเดือน 03:15–04:00 ET · HICP flash ปลายเดือน 05:00 ET · German IFO/ZEW',
        'NY option cut 10:00 ET ทุกวัน · London fix 11:00 ET (ปลายเดือนแรง)',
    ],
};

// ======================= GBPUSD =======================

const GBPUSD_MODES: Record<GoldMode, GoldModeSpec> = {
    scalp: {
        ttl: 60,
        news: 10,
        rrMin: 1.5,
        horizon: 'เข้า-ออกภายใน 1–4 ชั่วโมง',
        tfRoles: '5m = TF สั่งการ (entry/SL) · 15m = TF บริบท (ทิศ/liquidity pools)',
        slGuide:
            'SL เลยจุด sweep + 2–3 pips spread (cable spread กว้างกว่า EURUSD) · หรือ 0.5–0.8 × ATR14(5m) · ห้ามวางตรง 00/50 พอดี',
        playbook: [
            'Setup หลัก A — Liquidity Sweep: cable ชอบกวาด stop แรงกว่า EURUSD — ราคาแทงทะลุ high/low ของ session ก่อนหน้าหรือระดับ 00/50 แล้วปิดกลับทันที (แท่งกว้าง ≥1.1×ATR · ปิดสวนแรง · RVOL ≥1.3) → เข้าที่ retest แนวที่ทวงคืน · เป้า pool ฝั่งตรงข้าม · SL เลย sweep 0.5–0.8×ATR',
            'Setup หลัก B — Break-Retest กรอบเอเชีย: London open (14:00 ไทย / 03:00 ET) ทะลุ Asian range แล้ว retest ขอบ → เข้าตามทิศ · GBP มีข้อมูล UK 07:00 London (02:00 ET) ก่อน London open — ถ้าข่าวพึ่งออก รอแท่งปิดให้ชัดก่อน',
            'หน้าต่างทำเงิน: London open 14:00–16:00 ไทย และ overlap 19:00–23:00 ไทย — นอกหน้าต่าง spread 1–2 pips+ สัญญาณเชื่อไม่ได้ = NO-TRADE',
            'เลขกลม: 00/50 (เช่น 1.2700/1.2750) และ figure ใหญ่ทุก 100 pips — TP แรกไม่ข้าม figure ถัดไป · ใกล้ figure ให้รอ sweep ก่อน',
            'เป้าสมจริงต่อไม้: 10–20 pips (cable วิ่งแรงกว่า EURUSD ~30%) · ข่าว 08:30 ET (US) และ 02:00 ET (UK CPI/GDP/jobs) = NO-TRADE ±30 นาที · BoE พฤหัส 07:00 ET = งดก่อนประกาศ',
        ],
        sets: [
            { symbol: 'GBPUSD', tf: '5m', nBars: 500 },
            { symbol: 'GBPUSD', tf: '15m', nBars: 400 },
            { symbol: 'DXY', tf: '15m', nBars: 300 },
            { symbol: 'US10Y', tf: '15m', nBars: 300 },
            { symbol: 'EURUSD', tf: '15m', nBars: 300 },
        ],
    },
    intraday: {
        ttl: 120,
        news: 15,
        rrMin: 1.8,
        horizon: 'ถือหลักชั่วโมงถึงข้ามวัน (1–4 ชม. ขึ้นไป)',
        tfRoles: '15m/30m = จังหวะเข้า · 1h = TF สั่งการทิศ',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) หรือใต้/เหนือขอบ Asian range ฝั่งตรงข้าม · หลบ 00/50',
        playbook: [
            'เกมหลักคือวงจร 3 session: เอเชีย (06:00–14:00 ไทย) สร้างกรอบ 25–50 pips → London (14:00 ไทย) break/reject → ขี่ต่อเข้า NY — เป้ามาตรฐาน 1.5–2 เท่าของกรอบ · วันปกติ cable วิ่ง 80–120 pips',
            'Setup A — London break: ทะลุ Asian high/low + ปิดแท่ง 15m/30m นอกกรอบ + RVOL ≥1.2 + retest ไม่หลุดกลับ → เข้าที่ retest ขอบกรอบ (LIMIT)',
            'Setup B — London reject (fade): แทงทะลุแล้วปิดกลับใน (cable ทำ fake breakout แรงและบ่อย) → เล่นสวนไปขอบกรอบฝั่งตรงข้าม ครึ่งไม้ของ Setup A',
            'NY 08:30 ET data = จุดเร่ง/กลับทาง · UK data 02:00 ET เปลี่ยนทิศวันได้ทั้งวัน · BoE วัน (พฤหัส 07:00 ET) ห้ามเปิดก่อนประกาศ · FOMC 14:00 ET เช่นกัน',
            'ทิศระหว่างวันเช็คกับ DXY 1h และ EURUSD 1h: cable ขึ้นพร้อม EURUSD ขึ้น = เรื่อง USD อ่อน (ของจริง) · cable ขึ้นเดี่ยว = เรื่อง GBP (BoE/ข้อมูล UK) เปราะกว่า — ถ้า GBPUSD ขึ้นพร้อม DXY ขึ้น = ขาอ่อน อย่าไล่',
        ],
        sets: [
            { symbol: 'GBPUSD', tf: '15m', nBars: 400 },
            { symbol: 'GBPUSD', tf: '30m', nBars: 350 },
            { symbol: 'GBPUSD', tf: '1h', nBars: 400 },
            { symbol: 'DXY', tf: '1h', nBars: 300 },
            { symbol: 'US10Y', tf: '1h', nBars: 300 },
            { symbol: 'VIX', tf: '1h', nBars: 300 },
            { symbol: 'SPY', tf: '1h', nBars: 300 },
            { symbol: 'EURUSD', tf: '1h', nBars: 300 },
            { symbol: 'USDCHF', tf: '1h', nBars: 300 },
        ],
    },
    swing: {
        ttl: 300,
        news: 25,
        rrMin: 2.0,
        horizon: 'ถือหลายวันถึงหลายสัปดาห์',
        tfRoles: '1h = จังหวะเข้า · 4h = โครงสร้าง · 1d = TF สั่งการทิศใหญ่',
        slGuide:
            'SL ใต้/เหนือ swing low/high ของ pullback ที่ใช้เข้าเสมอ · ตรวจว่ากว้าง ≈ 1.0–1.5 × ATR14(1d) (~80–130 pips)',
        playbook: [
            'โครงหลัก (trend-pullback): 4H EMA50 vs EMA200 เป็น trend filter → รอ pullback เข้าโซน EMA20/50 4H · Fib 38.2/50/61.8 ของขาล่าสุด (61.8–78.6 = OTE) · หรือ figure เก่าที่กลายเป็นแนวรับ',
            'เข้าเมื่อมี confirmation เท่านั้น: แท่งกลับตัวบน 1H–4H · RSI divergence · break เส้นเทรนด์ย่อย — ไม่มี confirmation = LIMIT ที่โซนขนาดครึ่งเดียว',
            'Macro overlay: ตัวขับระดับสัปดาห์คือส่วนต่างดอกเบี้ย Fed vs BoE + risk sentiment (GBP เป็นสกุล beta สูง: risk-off โดนขายแรงกว่า EUR) · ความเชื่อมั่นการคลัง UK (ตลาด gilt — วิกฤต 2022 คือบทเรียน) · ราคาพลังงาน · positioning CFTC สุดขั้ว = เสี่ยง squeeze',
            'ระดับแม่เหล็ก: weekly open · prev week high/low · figure ใหญ่ทุก 100 pips (1.25/1.30/1.35) · option barrier',
            'EURUSD/USDCHF ใช้คอนเฟิร์มเผ่า: cable ขึ้นโดย EURUSD ตามและ USDCHF ลง = USD อ่อนทั้งกระดาน · cable ขึ้นเดี่ยว = เรื่อง GBP ล้วน ต้องดูข่าว BoE/UK ประกอบ',
        ],
        sets: [
            { symbol: 'GBPUSD', tf: '1h', nBars: 400 },
            { symbol: 'GBPUSD', tf: '4h', nBars: 360 },
            { symbol: 'GBPUSD', tf: '1d', nBars: 300 },
            { symbol: 'DXY', tf: '4h', nBars: 300 },
            { symbol: 'DXY', tf: '1d', nBars: 300 },
            { symbol: 'US10Y', tf: '1d', nBars: 300 },
            { symbol: 'VIX', tf: '1d', nBars: 300 },
            { symbol: 'SPY', tf: '1d', nBars: 300 },
            { symbol: 'EURUSD', tf: '1d', nBars: 300 },
            { symbol: 'USDCHF', tf: '1d', nBars: 300 },
        ],
    },
    position: {
        ttl: 900,
        news: 25,
        rrMin: 2.5,
        horizon: 'ถือหลายสัปดาห์ถึงหลายเดือน',
        tfRoles: '1d = จังหวะสะสม · 1w = TF สั่งการเทรนด์หลัก',
        slGuide: 'SL ใต้โครงสร้างรายสัปดาห์ (swing low 1w · ≈1.0–1.5 × ATR14(1w) ~200–300 pips) · ทยอยเข้า 3-4 ไม้',
        playbook: [
            'ทิศหลักจากโครงสร้าง 1W (ปิดรายสัปดาห์เหนือ/ใต้ EMA20W) · เทรนด์เดือนของ cable เดินตามวงจร Fed vs BoE และ "ความน่าเชื่อถือทางการคลัง" ของ UK',
            'เข้าเป็นไม้ ๆ ที่ pullback รายวันลึก (Fib 50–61.8 ของขา 1W) — ไม้แรกเมื่อแตะโซน ไม้ถัดไปเมื่อมีแท่งกลับตัวรายวัน/รายสัปดาห์ยืนยัน',
            'ตัวนำ: DXY รายสัปดาห์ new high แต่ cable ไม่ทำ new low = bullish divergence · EURUSD ไม่ยืนยัน = เรื่อง GBP เฉพาะตัว ระวัง',
            'โหมดนี้ event เดี่ยวไม่เปลี่ยนทิศ — สิ่งที่เปลี่ยนทิศคือจุดกลับ cycle Fed/BoE, งบประมาณ UK (Autumn/Spring statement), หรือ shock การเมือง → ทบทวน thesis',
        ],
        sets: [
            { symbol: 'GBPUSD', tf: '1d', nBars: 300 },
            { symbol: 'GBPUSD', tf: '1w', nBars: 200 },
            { symbol: 'DXY', tf: '1w', nBars: 200 },
            { symbol: 'US10Y', tf: '1w', nBars: 200 },
            { symbol: 'EURUSD', tf: '1w', nBars: 200 },
            { symbol: 'USDCHF', tf: '1w', nBars: 200 },
        ],
    },
};

const GBPUSD_BRIEF: InstrumentBrief = {
    persona_th:
        'คุณคือหัวหน้าโต๊ะ G10 FX ในลอนดอน เทรด cable (GBPUSD) มา 15 ปี ผ่าน Brexit 2016, flash crash ตุลาคม 2016, วิกฤต gilt 2022 — รู้ว่าปอนด์กวาด stop แรงและเร็วกว่าคู่อื่น จึงเคารพความเสี่ยงเหนือทุกสิ่ง',
    drivers_th: [
        'ส่วนต่างดอกเบี้ย Fed vs BoE และความคาดหวัง cycle · BoE ประชุม 8 ครั้ง/ปี พฤหัส 12:00 London (07:00 ET)',
        'Risk sentiment: GBP เป็นสกุล beta สูง — risk-off โดนขายแรงกว่า EUR · risk-on ขึ้นแรงกว่า',
        'DXY (corr ≈ −0.85) และ EURUSD (corr ≈ +0.8) — แยกให้ออกว่าเป็นเรื่อง USD หรือเรื่อง GBP',
        'ความเชื่อมั่นการคลัง/การเมือง UK: ตลาด gilt ป่วน = ปอนด์ร่วงทันที (กันยายน 2022)',
        'ข้อมูล UK 07:00 London (02:00 ET): CPI, GDP, ค่าจ้าง/การจ้างงาน, retail sales — เปลี่ยนทิศวันได้',
        'ข้อมูล US 08:30 ET และ FOMC 14:00 ET กระทบเท่ากันเพราะ USD คือครึ่งหนึ่งของคู่',
    ],
    behaviour_th: [
        'ช่วงราคาปกติ 80–120 pips/วัน (แรงกว่า EURUSD ~30%) · spread กว้างกว่า EURUSD ~2 เท่า',
        'กวาด stop ที่ 00/50 และ swing high/low แรงและบ่อย — sweep แล้วกลับเป็นนิสัย',
        'Asian range 25–50 pips → London open break/reject · fake breakout บ่อยมากช่วง 03:00–04:00 ET',
        'เทรนด์วันมักตั้งแต่ London open ถึง 11:00 ET (London fix) แล้วหมดแรง',
        'ปลายเดือน London fix 11:00 ET flow แรงผิดปกติ',
    ],
    sessions_th: [
        'Asia 06:00–14:00 ไทย: เงียบ สร้าง Asian range',
        'UK data 14:00 ไทย (02:00 ET) → London open 15:00 ไทย (03:00 ET): แรงขยับแรก',
        'London–NY overlap 19:00–23:00 ไทย (08:00–12:00 ET): volume สูงสุด · 08:30 ET ข่าว US · 10:00 ET option cut',
        'หลัง London fix 22:00 ไทย (11:00 ET): สภาพคล่องลด เทรนด์หยุด · rollover 17:00 ET spread ถ่าง',
        'ตลาด 24/5: อาทิตย์ 17:05 ET → ศุกร์ 16:55 ET',
    ],
    levels_th: [
        'SL พ้นโครงสร้าง + 2–3 pips spread และไม่ทับ 00/50 — cable ต้องให้ room มากกว่า EURUSD',
        'TP แรกไม่ข้าม figure/half-figure ถัดไป · prev day high/low · weekly open',
        'Entry ตรงโครงสร้าง: retest ขอบกรอบ, แนวที่ทวงคืน, Fib 50–61.8, EMA20/50 4H',
        'มูลค่า: 1 lot = £100,000 → 1 pip = $10 · SL 40 pips ที่ 0.1 lot = เสี่ยง $40',
    ],
    risks_th: [
        'Fake breakout London open — รอแท่ง 15m ปิด + RVOL ≥1.2',
        'ข้อมูล UK 02:00 ET ออกก่อน London open — ไม้ที่ตั้งไว้ข้ามคืนโดนกวาดได้',
        'เทรดสวน DXY/EURUSD: cable ขึ้นเดี่ยว = เรื่อง GBP ล้วน เปราะกว่า',
        'BoE/FOMC วัน: 100+ pips ในนาทีเดียว · วันที่มีทั้ง UK และ US data = ผันผวนสองรอบ',
    ],
    events_th: [
        'BoE พฤหัส 07:00 ET (8 ครั้ง/ปี) · FOMC 14:00 ET',
        'UK: CPI กลางเดือน 02:00 ET · jobs/ค่าจ้างกลางเดือน 02:00 ET · GDP รายเดือน · retail sales',
        'US: NFP ศุกร์แรก, CPI, PCE, jobless — 08:30 ET',
        'NY option cut 10:00 ET · London fix 11:00 ET · งบประมาณ UK (Autumn/Spring statement)',
    ],
};

// ======================= USDJPY =======================

const USDJPY_MODES: Record<GoldMode, GoldModeSpec> = {
    scalp: {
        ttl: 60,
        news: 10,
        rrMin: 1.5,
        horizon: 'เข้า-ออกภายใน 1–4 ชั่วโมง',
        tfRoles: '5m = TF สั่งการ (entry/SL) · 15m = TF บริบท (ทิศ/liquidity pools)',
        slGuide: 'SL เลยจุด sweep + 1–2 pips spread · หรือ 0.5–0.8 × ATR14(5m) · ห้ามวางตรง xx.00 / xx.50 พอดี',
        playbook: [
            'Setup หลัก A — Liquidity Sweep: ราคาแทงทะลุ high/low ของ session ก่อนหน้าหรือระดับ .00/.50 แล้วปิดกลับเข้ากรอบทันที (แท่งกว้าง ≥1.1×ATR · ปิดสวนแรง · RVOL ≥1.3) → เข้าที่ retest แนวที่ทวงคืน · เป้า pool ฝั่งตรงข้าม · SL เลย sweep 0.5–0.8×ATR · USDJPY ถูกกวาดบ่อยช่วง Tokyo fix 09:55 JST (07:55 ไทย)',
            'Setup หลัก B — Break-Retest กรอบเอเชีย: ต่างจากคู่ยุโรป — Tokyo คือ session หลักของเยน กรอบเอเชียจึงกว้างและมี flow จริง (gotobi วันที่ 5/10/15/20/25/30 ผู้นำเข้าซื้อ USD เข้า fix) · London open (03:00 ET) ทะลุกรอบแล้ว retest ขอบ → เข้าตามทิศ',
            'หน้าต่างทำเงิน: Tokyo open 06:00–08:00 ไทย (19:00–21:00 ET) · London open 14:00–16:00 ไทย · overlap 19:00–23:00 ไทย — นอกหน้าต่างนี้ (โดยเฉพาะหลัง NY ปิด) NO-TRADE',
            'เลขกลม: xx.00 และ xx.50 คือด่าน (option barrier + stop) · figure ใหญ่ทุก 1.00 เยน · ระดับ "การเมือง" 150/155/160 = โซนที่ MoF เคยแทรกแซง — เข้าฝั่ง BUY ใกล้โซนนี้ต้องลดขนาดหรืองด',
            'เป้าสมจริงต่อไม้: 8–15 pips (0.08–0.15 เยน) · ข่าว 08:30 ET (US) = NO-TRADE ±30 นาที · BoJ ประกาศช่วง 22:30–00:30 ET ไม่มีเวลาตายตัว — วัน BoJ งด scalp ช่วง Tokyo · "rate check"/คำเตือนจาก MoF = สัญญาณแทรกแซง ปิดไม้ BUY ทันที',
        ],
        sets: [
            { symbol: 'USDJPY', tf: '5m', nBars: 500 },
            { symbol: 'USDJPY', tf: '15m', nBars: 400 },
            { symbol: 'DXY', tf: '15m', nBars: 300 },
            { symbol: 'US10Y', tf: '15m', nBars: 300 },
            { symbol: 'NIKKEI', tf: '15m', nBars: 300 },
        ],
    },
    intraday: {
        ttl: 120,
        news: 15,
        rrMin: 1.8,
        horizon: 'ถือหลักชั่วโมงถึงข้ามวัน (1–4 ชม. ขึ้นไป)',
        tfRoles: '15m/30m = จังหวะเข้า · 1h = TF สั่งการทิศ',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) หรือใต้/เหนือขอบ Asian range ฝั่งตรงข้าม · หลบ .00/.50',
        playbook: [
            'เกมหลักคือวงจร 3 session แต่เยนต่างตรงที่ Tokyo (06:00–14:00 ไทย) มี flow จริง: gotobi/ผู้นำเข้าซื้อ USD เข้า fix 09:55 JST · ผู้ส่งออกขาย USD เหนือ figure — กรอบเอเชียจึงเป็น "กรอบที่มีความหมาย" → London break/reject → NY ขี่ต่อ · เป้า 1.5–2 เท่าของกรอบ · วันปกติวิ่ง 70–120 pips',
            'Setup A — London break: ทะลุ Asian high/low + ปิดแท่ง 15m/30m นอกกรอบ + RVOL ≥1.2 + retest ไม่หลุดกลับ → เข้าที่ retest ขอบกรอบ (LIMIT) · ทิศต้องสอดคล้อง US10Y 1h (yields ขึ้น = USDJPY ขึ้น)',
            'Setup B — London reject (fade): แทงทะลุแล้วปิดกลับใน → เล่นสวนไปขอบกรอบฝั่งตรงข้าม ครึ่งไม้ของ Setup A',
            'NY 08:30 ET data = จุดเร่ง/กลับทาง (USDJPY ตอบสนอง yields แรงสุดในบรรดา major) · FOMC 14:00 ET · BoJ วัน (22:30–00:30 ET) ห้ามถือไม้ไม่มี buffer ข้าม · คำเตือนแทรกแซงจาก MoF/BoJ = ปิดไม้ BUY',
            'ทิศระหว่างวันเช็คกับ US10Y 1h เสมอ (corr +0.7..+0.9 คือตัวขับหลัก) + DXY + Nikkei/SPY (risk-on = carry เดินต่อ = USDJPY ขึ้น · risk-off = unwind carry = ร่วงแรง) — ถ้า USDJPY ขึ้นแต่ yields ลง = ขาอ่อน อย่าไล่',
        ],
        sets: [
            { symbol: 'USDJPY', tf: '15m', nBars: 400 },
            { symbol: 'USDJPY', tf: '30m', nBars: 350 },
            { symbol: 'USDJPY', tf: '1h', nBars: 400 },
            { symbol: 'US10Y', tf: '1h', nBars: 300 },
            { symbol: 'DXY', tf: '1h', nBars: 300 },
            { symbol: 'VIX', tf: '1h', nBars: 300 },
            { symbol: 'SPY', tf: '1h', nBars: 300 },
            { symbol: 'NIKKEI', tf: '1h', nBars: 300 },
            { symbol: 'WTI', tf: '1h', nBars: 300 },
        ],
    },
    swing: {
        ttl: 300,
        news: 25,
        rrMin: 2.0,
        horizon: 'ถือหลายวันถึงหลายสัปดาห์',
        tfRoles: '1h = จังหวะเข้า · 4h = โครงสร้าง · 1d = TF สั่งการทิศใหญ่',
        slGuide:
            'SL ใต้/เหนือ swing low/high ของ pullback ที่ใช้เข้าเสมอ · ตรวจว่ากว้าง ≈ 1.0–1.5 × ATR14(1d) (~100–150 pips)',
        playbook: [
            'โครงหลัก (trend-pullback): 4H EMA50 vs EMA200 เป็น trend filter → รอ pullback เข้าโซน EMA20/50 4H · Fib 38.2/50/61.8 ของขาล่าสุด (61.8–78.6 = OTE) · หรือ figure เก่าที่กลายเป็นแนวรับ',
            'เข้าเมื่อมี confirmation เท่านั้น: แท่งกลับตัวบน 1H–4H · RSI divergence · break เส้นเทรนด์ย่อย — ไม่มี confirmation = LIMIT ที่โซนขนาดครึ่งเดียว',
            'Macro overlay: USDJPY = ส่วนต่าง yield US−JP (US10Y − JGB10Y) แทบตรงตัว corr +0.8 · BoJ เดินออกจากนโยบายผ่อนคลาย (ขึ้นดอกเบี้ย/ลด JGB) = เยนแข็งโครงสร้าง · carry trade ใหญ่: risk-off = unwind แรงและเร็ว (สิงหาคม 2024 ร่วง 12% ใน 3 สัปดาห์) — ฝั่ง BUY ต้องมีแผนหนีเสมอ · โซน 150–162 = ประวัติแทรกแซงของ MoF ฝั่ง BUY เหนือโซนนี้ให้ลดขนาดครึ่ง',
            'ระดับแม่เหล็ก: weekly open · prev week high/low · figure ทุก 1.00 เยน · ระดับแทรกแซงเดิม (151.9 / 157.5 / 160+)',
            'Nikkei/SPY ใช้คอนเฟิร์ม regime: USDJPY ขึ้นพร้อม Nikkei ขึ้นและ VIX ต่ำ = carry แข็งแรง · USDJPY ขึ้นแต่ VIX พุ่ง = ขาที่พร้อม unwind เปราะมาก',
        ],
        sets: [
            { symbol: 'USDJPY', tf: '1h', nBars: 400 },
            { symbol: 'USDJPY', tf: '4h', nBars: 360 },
            { symbol: 'USDJPY', tf: '1d', nBars: 300 },
            { symbol: 'US10Y', tf: '4h', nBars: 300 },
            { symbol: 'US10Y', tf: '1d', nBars: 300 },
            { symbol: 'DXY', tf: '1d', nBars: 300 },
            { symbol: 'VIX', tf: '1d', nBars: 300 },
            { symbol: 'SPY', tf: '1d', nBars: 300 },
            { symbol: 'NIKKEI', tf: '1d', nBars: 300 },
            { symbol: 'WTI', tf: '1d', nBars: 300 },
        ],
    },
    position: {
        ttl: 900,
        news: 25,
        rrMin: 2.5,
        horizon: 'ถือหลายสัปดาห์ถึงหลายเดือน',
        tfRoles: '1d = จังหวะสะสม · 1w = TF สั่งการเทรนด์หลัก',
        slGuide: 'SL ใต้โครงสร้างรายสัปดาห์ (swing low 1w · ≈1.0–1.5 × ATR14(1w) ~250–400 pips) · ทยอยเข้า 3-4 ไม้',
        playbook: [
            'ทิศหลักจากโครงสร้าง 1W (ปิดรายสัปดาห์เหนือ/ใต้ EMA20W) · เทรนด์เดือนของ USDJPY เดินตามส่วนต่าง yield US−JP และทิศนโยบาย BoJ (normalisation = เยนแข็งระยะยาว)',
            'เข้าเป็นไม้ ๆ ที่ pullback รายวันลึก (Fib 50–61.8 ของขา 1W) — ไม้แรกเมื่อแตะโซน ไม้ถัดไปเมื่อมีแท่งกลับตัวรายวัน/รายสัปดาห์ยืนยัน',
            'ตัวนำ: US10Y รายสัปดาห์ทำ new high แต่ USDJPY ไม่ตาม = มีแรงขายเยนถูกดูดซับ (แทรกแซง/ผู้ส่งออก) ระวังฝั่ง BUY · VIX ฐานสูงขึ้น = carry กำลังจะ unwind',
            'โหมดนี้ event เดี่ยวไม่เปลี่ยนทิศ — สิ่งที่เปลี่ยนทิศคือการแทรกแซงจริงของ MoF, จุดกลับ cycle Fed, หรือ BoJ เปลี่ยนกรอบนโยบาย → ทบทวน thesis ทุกครั้ง',
        ],
        sets: [
            { symbol: 'USDJPY', tf: '1d', nBars: 300 },
            { symbol: 'USDJPY', tf: '1w', nBars: 200 },
            { symbol: 'US10Y', tf: '1w', nBars: 200 },
            { symbol: 'DXY', tf: '1w', nBars: 200 },
            { symbol: 'NIKKEI', tf: '1w', nBars: 200 },
            { symbol: 'VIX', tf: '1w', nBars: 200 },
        ],
    },
};

const USDJPY_BRIEF: InstrumentBrief = {
    persona_th:
        'คุณคือหัวหน้าโต๊ะ JPY ของธนาคารญี่ปุ่นในโตเกียว เทรด USDJPY มา 15 ปี ผ่านการแทรกแซงปี 2022/2024, carry unwind สิงหาคม 2024, BoJ เลิก YCC — รู้ว่าเยนคือคู่ที่ "การเมืองนโยบาย" ชี้ราคา จึงเคารพความเสี่ยงเหนือทุกสิ่ง',
    drivers_th: [
        'ส่วนต่าง yield US−JP (US10Y − JGB10Y) คือตัวขับหลัก corr +0.7..+0.9 — USDJPY ตอบสนอง US yields แรงกว่า major คู่อื่น',
        'BoJ: normalisation (ขึ้นดอกเบี้ย/ลดซื้อ JGB) = เยนแข็งโครงสร้าง · ประชุมไม่มีเวลาตายตัว (ราว 22:30–00:30 ET) · แถลง Ueda 01:30 ET',
        'MoF/BoJ intervention: เตือนด้วยวาจา → rate check → แทรกแซงจริง (ขาย USD หลายหมื่นล้าน) ร่วง 3–5 เยนในชั่วโมง · โซนประวัติ 150–162',
        'Carry trade: risk-on = ยืม JPY ซื้อสินทรัพย์เสี่ยง = USDJPY ขึ้นช้า ๆ · risk-off = unwind ร่วงเร็วและแรง (asymmetric)',
        'Flow จริงฝั่งญี่ปุ่น: ผู้นำเข้าซื้อ USD เข้า Tokyo fix 09:55 JST (gotobi 5/10/15/20/25/30) · ผู้ส่งออกขาย USD เหนือ figure · กองทุนบำนาญ GPIF/ประกันชีวิต hedge ratio',
        'ข้อมูล US 08:30 ET และ FOMC 14:00 ET กระทบแรงผ่านช่องทาง yields · น้ำมันแพง = ญี่ปุ่นเสียดุล เยนอ่อน',
    ],
    behaviour_th: [
        'ช่วงราคาปกติ 70–120 pips (0.70–1.20 เยน)/วัน · spread แคบมากช่วง Tokyo/London',
        'เลขกลม .00/.50 = option barrier + stop · figure ทุก 1.00 เยน เป็นด่านจิตวิทยา · 150/155/160 = ด่านการเมือง',
        'Tokyo session มี flow จริง (ต่างจาก EURUSD ที่เงียบ) — กรอบเอเชียกว้างและมักกวาดรอบ fix 09:55 JST',
        'เทรนด์ขึ้นเป็นบันได (carry) แต่ขาลงเป็นลิฟต์ (unwind/แทรกแซง) — ฝั่ง BUY ต้องล็อกกำไรเร็วกว่าฝั่ง SELL',
        'ตอบสนอง headline ทันที: คำว่า "intervention / rate check / excessive moves" จาก MoF = ขายก่อนถามทีหลัง',
    ],
    sessions_th: [
        'Tokyo 06:00–14:00 ไทย (19:00–03:00 ET): session หลักของเยน · fix 09:55 JST = 07:55 ไทย · BoJ/ข้อมูลญี่ปุ่นออกช่วงนี้',
        'London open 14:00 ไทย (03:00 ET): break/reject กรอบ Tokyo',
        'London–NY overlap 19:00–23:00 ไทย (08:00–12:00 ET): volume สูงสุด · 08:30 ET ข่าว US กระทบผ่าน yields',
        'หลัง 12:00 ET ถึง Tokyo เปิด: บาง spread ถ่าง · rollover 17:00 ET (swap สูงเพราะส่วนต่างดอกเบี้ย — ถือ SELL ข้ามคืนเสีย swap)',
        'ตลาด 24/5: อาทิตย์ 17:05 ET → ศุกร์ 16:55 ET',
    ],
    levels_th: [
        'SL พ้นโครงสร้าง + 1–2 pips และไม่ทับ .00/.50 · ฝั่ง BUY ใกล้โซนแทรกแซง (150+) ต้องให้ SL แคบลงหรือลดขนาด',
        'TP แรกไม่ข้าม figure ถัดไป · prev day high/low · weekly open · ระดับแทรกแซงเดิม',
        'Entry ตรงโครงสร้าง: retest ขอบกรอบ Tokyo, แนวที่ทวงคืน, Fib 50–61.8, EMA20/50 4H',
        'มูลค่า: 1 lot = $100,000 → 1 pip (0.01) ≈ $6.5–7 (เปลี่ยนตามราคา: 100,000×0.01/ราคา) · SL 40 pips ที่ 0.1 lot ≈ เสี่ยง $27',
    ],
    risks_th: [
        'แทรกแซงจริง: ฝั่ง BUY ร่วง 300–500 pips ใน 1 ชั่วโมง — เหนือ 150 ห้ามถือ BUY ไม่มี SL',
        'Carry unwind: VIX พุ่ง + Nikkei ร่วง = USDJPY ร่วงเร็วกว่าที่ ATR บอก',
        'BoJ วัน: เวลาไม่ตายตัว ไม้ที่ตั้งไว้โดนกวาดช่วง Tokyo',
        'เทรดสวน US10Y: USDJPY ขึ้นแต่ yields ลง = ขาปลอม',
    ],
    events_th: [
        'BoJ 8 ครั้ง/ปี (ประกาศ ~22:30–00:30 ET, แถลง 01:30 ET) · FOMC 14:00 ET',
        'US: NFP/CPI/PCE/jobless 08:30 ET · Treasury auction 13:00 ET (yields กระโดด)',
        'ญี่ปุ่น: Tokyo CPI ปลายเดือน 19:30 ET · Tankan รายไตรมาส · ค่าจ้าง (shunto) มีนาคม',
        'Tokyo fix 09:55 JST ทุกวัน (gotobi แรงกว่า) · NY option cut 10:00 ET · ปลายปีงบประมาณญี่ปุ่น (มีนาคม) repatriation flow',
    ],
};

export const FX_CONTENT: Record<'EURUSD' | 'GBPUSD' | 'USDJPY', FxContent> = {
    EURUSD: {
        modes: EURUSD_MODES,
        companionBrief_th:
            'สรุปผลของแต่ละตัวประกอบต่อ EURUSD ในโหมดนี้: DXY (กระจกเงา สวนทาง), US10Y (yields US ขึ้น = USD แข็ง กดยูโร), VIX (กลัว = USD แข็ง กดยูโร), SPY (risk-on หนุนยูโร), GBPUSD (เพื่อนร่วมเผ่า ต้องไปทางเดียวกัน), USDCHF (สวนทางเกือบกระจก) — ตัวไหนหนุน ตัวไหนขัด สุทธิแล้วเข้าข้างฝั่งไหน',
        sessionMap: FX_SESSION_MAP(
            'EURUSD วิ่ง 60–90 pips/วันเป็นปกติ — วางเป้า/SL ให้สมส่วนกับ ATR จริง ไม่ใช่ความหวัง',
        ),
        readingGuide: FX_READING_GUIDE(
            'EURUSD แพ้เมื่อ: DXY แข็ง + yields US ขึ้นเร็วกว่า Bund + risk-off (VIX ขึ้น) + พลังงานแพง · EURUSD ชนะเมื่อ: DXY อ่อน + ECB hawkish กว่า Fed + risk-on (SPY ขึ้น) · GBPUSD ต้องยืนยันทิศเดียวกัน USDCHF ต้องสวนทาง ไม่งั้นเป็นเรื่องยูโรเฉพาะตัว',
            'spread ปกติ 0.1–0.5 pip ถ่างเป็น 2–5 pips ช่วง rollover/ข่าว',
        ),
        brief: EURUSD_BRIEF,
    },
    GBPUSD: {
        modes: GBPUSD_MODES,
        companionBrief_th:
            'สรุปผลของแต่ละตัวประกอบต่อ GBPUSD ในโหมดนี้: DXY (สวนทาง), US10Y (yields US ขึ้น = กดปอนด์), VIX (กลัว = ปอนด์โดนขายแรงเพราะ beta สูง), SPY (risk-on หนุนปอนด์), EURUSD (เพื่อนร่วมเผ่า), USDCHF (สวนทาง) — ตัวไหนหนุน ตัวไหนขัด สุทธิแล้วเข้าข้างฝั่งไหน',
        sessionMap: FX_SESSION_MAP(
            'GBPUSD วิ่ง 80–120 pips/วันเป็นปกติ (แรงกว่า EURUSD) — วางเป้า/SL ให้สมส่วนกับ ATR จริง',
        ),
        readingGuide: FX_READING_GUIDE(
            'GBPUSD แพ้เมื่อ: DXY แข็ง + risk-off (ปอนด์ beta สูง) + BoE dovish กว่า Fed + ตลาด gilt ป่วน · ชนะเมื่อ: DXY อ่อน + risk-on + BoE hawkish + ข้อมูล UK ดี · EURUSD ต้องยืนยันทิศเดียวกัน ไม่งั้นเป็นเรื่องปอนด์เฉพาะตัว',
            'spread ปกติ 0.5–1 pip ถ่างเป็น 3–8 pips ช่วง rollover/ข่าว UK',
        ),
        brief: GBPUSD_BRIEF,
    },
    USDJPY: {
        modes: USDJPY_MODES,
        companionBrief_th:
            'สรุปผลของแต่ละตัวประกอบต่อ USDJPY ในโหมดนี้: US10Y (ตัวขับหลัก ขึ้น = หนุน), DXY (หนุน), VIX (กลัว = unwind carry กดแรง), SPY/Nikkei (risk-on = carry เดินต่อ หนุน), WTI (น้ำมันแพง = เยนอ่อน) — ตัวไหนหนุน ตัวไหนขัด สุทธิแล้วเข้าข้างฝั่งไหน + ระยะห่างจากโซนแทรกแซง',
        sessionMap: FX_SESSION_MAP(
            'USDJPY วิ่ง 70–120 pips (0.70–1.20 เยน)/วันเป็นปกติ — ขาลงจาก unwind/แทรกแซงวิ่งเร็วกว่าขาขึ้นมาก',
        ),
        readingGuide: FX_READING_GUIDE(
            'USDJPY ขึ้นเมื่อ: US yields ขึ้น + DXY แข็ง + risk-on (Nikkei/SPY ขึ้น VIX ต่ำ) + BoJ ผ่อนคลาย · USDJPY ลงเมื่อ: yields ลง + risk-off (VIX พุ่ง = carry unwind) + BoJ hawkish + MoF แทรกแซง/เตือน · ฝั่ง BUY เหนือ 150 ต้องนับความเสี่ยงแทรกแซงเสมอ',
            'spread ปกติ 0.1–0.5 pip ถ่างช่วง rollover (swap สูง) และ BoJ/แทรกแซง',
        ),
        brief: USDJPY_BRIEF,
    },
};
