/**
 * Ported 1:1 from z-service backend/gold.py (GOLD_MODES / _COMP_EXCH / _INTERVALS /
 * formula sections). Keep the Thai strings verbatim — they are the analyst brief.
 *
 * Data sources in this port:
 *  - XAUUSD: cTrader Open API trendbars (the exact feed this bot trades on)
 *  - companions: Yahoo Finance (same instruments the dash/thestock use)
 */
import { GoldMode } from '../data/gold-data.service';

export interface GoldSet {
    symbol: string;
    tf: string;
    nBars: number;
}

export interface GoldModeSpec {
    ttl: number; // seconds — local cache per mode
    news: number; // news item limit
    rrMin: number;
    horizon: string;
    tfRoles: string;
    slGuide: string;
    playbook: string[];
    sets: GoldSet[];
}

export const INTERVAL_MS: Record<string, number> = {
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 3_600_000,
    '4h': 4 * 3_600_000,
    '1d': 86_400_000,
    '1w': 7 * 86_400_000,
};

/** cTrader ProtoOATrendbarPeriod enum values */
export const CTRADER_PERIOD: Record<string, number> = {
    '5m': 5,
    '15m': 7,
    '30m': 8,
    '1h': 9,
    '4h': 10,
    '1d': 12,
    '1w': 13,
};

/** Yahoo Finance symbol + native interval per companion. 4h is resampled from 60m. */
export const YAHOO_SYMBOL: Record<string, string> = {
    DXY: 'DX-Y.NYB',
    US10Y: '^TNX',
    VIX: '^VIX',
    SPY: 'SPY',
    WTI: 'CL=F',
    BTCUSDT: 'BTC-USD',
    USDJPY: 'USDJPY=X',
    XAGUSD: 'SI=F',
    GDX: 'GDX',
    // forex companions (ใช้เมื่อตราสารหลักเป็นคู่เงิน — ตัวที่เป็นตราสารหลักเองจะดึงจาก cTrader แทน)
    EURUSD: 'EURUSD=X',
    GBPUSD: 'GBPUSD=X',
    USDCHF: 'USDCHF=X',
    NIKKEI: '^N225',
};

export const YAHOO_INTERVAL: Record<string, string> = {
    '15m': '15m',
    '30m': '30m',
    '1h': '60m',
    '4h': '60m',
    '1d': '1d',
    '1w': '1wk',
};

export const NEWS_FEEDS = [
    {
        name: 'CNBC (World)',
        url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362',
    },
    { name: 'Investing.com', url: 'https://www.investing.com/rss/news_14.rss' },
    { name: 'MarketWatch Top', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
    { name: 'NYT Business (US)', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' },
];

export const GOLD_MODES: Record<GoldMode, GoldModeSpec> = {
    scalp: {
        ttl: 60,
        news: 10,
        rrMin: 1.5,
        horizon: 'เข้า-ออกภายใน 1–4 ชั่วโมง',
        tfRoles: '5m = TF สั่งการ (entry/SL) · 15m = TF บริบท (ทิศ/liquidity pools)',
        slGuide:
            'SL เหนือ/ใต้จุด sweep + buffer spread · หรือ 0.5–0.8 × ATR14(5m) · ห้ามวางตรงเลขกลม $50/$100 พอดี (โดนกวาดบ่อยสุด)',
        playbook: [
            'Setup หลัก A — Liquidity Sweep: ราคาแทงทะลุ high/low ชัด ๆ หรือเลขกลม ($xx50/$xx00) แล้วดีดกลับเข้า range ทันที (sweep+displacement) → เข้าที่ retest ของแนวที่เพิ่งทะลุ/FVG · เป้า = pool ฝั่งตรงข้าม · SL เลย sweep เล็กน้อย',
            'Setup หลัก B — Break-Retest กรอบเอเชีย: ตี London open (14:00 ไทย / 03:00 ET) ราคาทะลุกรอบ Asian range แล้วย่อกลับมา retest ขอบกรอบ → เข้าตามทิศทะลุ · สถิติ: breakout วิ่งเฉลี่ย 1.5–2 เท่าของความกว้างกรอบเอเชีย',
            'หน้าต่างทำเงินของโหมดนี้: London open 14:00-16:00 ไทย และ London-NY overlap 19:00-23:00 ไทย (08:00-12:00 ET = ช่วง volume สูงสุดของวัน) — นอกหน้าต่างนี้ (โดยเฉพาะหลังปิด NY ถึงเอเชียเปิด) spread กว้าง สัญญาณเชื่อไม่ได้ = NO-TRADE โดยปริยาย',
            'เลขกลม: ทองหยุด/เด้ง/กลับตัวที่ระดับ $50 และ $100 อย่างเป็นระบบ — TP แรกอย่าตั้งข้ามเลขกลมถัดไป · entry ใกล้เลขกลมให้รอ sweep ก่อนไม่ดักหน้า',
            'เป้าสมจริงต่อไม้: $2–4 (20–40 pips) · ข่าว 19:30 ไทย (08:30 ET: NFP/CPI/jobless) = NO-TRADE ±30 นาที — นาทีข่าวคือ timestamp ผันผวนสุดของสัปดาห์ spread ถ่างและ slippage แรง',
        ],
        sets: [
            { symbol: 'XAUUSD', tf: '5m', nBars: 500 },
            { symbol: 'XAUUSD', tf: '15m', nBars: 400 },
            { symbol: 'DXY', tf: '15m', nBars: 300 },
            { symbol: 'US10Y', tf: '15m', nBars: 300 },
            { symbol: 'USDJPY', tf: '15m', nBars: 300 },
        ],
    },
    intraday: {
        ttl: 120,
        news: 15,
        rrMin: 1.8,
        horizon: 'ถือหลักชั่วโมงถึงข้ามวัน (1–4 ชม. ขึ้นไป)',
        tfRoles: '15m/30m = จังหวะเข้า · 1h = TF สั่งการทิศ',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) หรือใต้/เหนือขอบ Asian range ฝั่งตรงข้าม · หลบเลขกลม',
        playbook: [
            'เกมหลักของโหมดนี้คือวงจร 3 session: เอเชีย (06:00-14:00 ไทย) สร้างกรอบวัน → London (14:00 ไทย) break หรือ reject กรอบ → ขี่ต่อเข้า NY (19:30 ไทย) — เป้ามาตรฐาน 1.5–2 เท่าของความกว้างกรอบเอเชีย',
            'Setup A — London break: ทะลุ Asian high/low + ปิดแท่ง 15m/30m นอกกรอบ + retest ไม่หลุดกลับ → BUY STOP/SELL STOP ตามทิศ หรือเข้าที่ retest',
            'Setup B — London reject (fade): แทงทะลุกรอบแล้วปิดกลับใน (fake breakout) → เล่นสวนไปเป้าขอบกรอบฝั่งตรงข้าม — ครึ่งไม้ของ Setup A',
            'NY 19:30 ไทย (08:30 ET) data คือจุดเร่ง/กลับทางกลางวัน — ถือผ่านได้เฉพาะไม้ที่มีกำไร buffer แล้ว ไม้ใหม่ให้รอหลังข่าว 15-30 นาที · FOMC วัน = ห้ามเปิดก่อน 01:00 ไทย (14:00 ET)',
            'ทิศระหว่างวันเช็คกับ DXY/US10Y 1h เสมอ: ทองสวน DXY (corr −0.5..−0.8) — ถ้าทองขึ้นพร้อม DXY ขึ้น = ขาที่อ่อนแอ อย่าไล่',
        ],
        sets: [
            { symbol: 'XAUUSD', tf: '15m', nBars: 400 },
            { symbol: 'XAUUSD', tf: '30m', nBars: 350 },
            { symbol: 'XAUUSD', tf: '1h', nBars: 400 },
            { symbol: 'DXY', tf: '1h', nBars: 300 },
            { symbol: 'US10Y', tf: '1h', nBars: 300 },
            { symbol: 'VIX', tf: '1h', nBars: 300 },
            { symbol: 'USDJPY', tf: '1h', nBars: 300 },
            { symbol: 'SPY', tf: '1h', nBars: 300 },
        ],
    },
    swing: {
        ttl: 300,
        news: 25,
        rrMin: 2.0,
        horizon: 'ถือหลายวันถึงหลายสัปดาห์',
        tfRoles: '1h = จังหวะเข้า · 4h = โครงสร้าง · 1d = TF สั่งการทิศใหญ่',
        slGuide:
            'SL ใต้/เหนือ swing low/high ของ pullback ที่ใช้เข้าเสมอ (ไม่ใช่ ATR ลอย ๆ ไม่ใช่เลขกลม) · ตรวจว่ากว้าง ≈ 1.0–1.5 × ATR14(1d)',
        playbook: [
            'โครงหลัก (trend-pullback): ใช้ 4H EMA50 vs EMA200 เป็น trend filter (50>200 = เล่นฝั่ง BUY เท่านั้น) → รอ pullback เข้าโซนใดโซนหนึ่ง: EMA20/50 4H · Fib 38.2/50/61.8 ของขาล่าสุด (โซนลึก 61.8–78.6 = OTE ให้ RR ดีสุด) · หรือแนวต้านเก่าที่กลายเป็นแนวรับ',
            'เข้าเมื่อมี confirmation เท่านั้น: แท่งกลับตัว (hammer/engulfing) บน 1H-4H · RSI divergence · หรือ break เส้นเทรนด์ย่อยของ pullback — ไม่มี confirmation = ตั้ง BUY LIMIT ที่โซนได้แต่ขนาดครึ่งเดียว',
            'Macro overlay ก่อนสรุปทิศ: ความสัมพันธ์ทอง-REAL YIELD แบบเก่า (corr ≈ −0.82) แตกไปแล้วตั้งแต่ 2022 (เหลือ ~3-7% — ธนาคารกลางกลายเป็นผู้ซื้อหลัก ปี 2025 yields สูงสุดตั้งแต่ 2007 แต่ทองขึ้น 65%) → ใช้ US10Y เป็นตัวประกอบรองแบบ asymmetric: yields ลง = หนุนทองแรง แต่ yields ขึ้น = กดทองน้อยกว่าที่เคย ห้ามใช้ veto ฝั่ง BUY เพียงลำพัง · DXY ยังใช้ได้ corr −0.5..−0.8 · สัญญาณสถาบันสองแบบ: ① DXY ทำ new high แต่ทองไม่ทำ new low = bullish divergence (มีคนรับของ) ② yields+DXY ขึ้นแต่ทอง sideways = hidden accumulation',
            'ระดับที่เป็นแม่เหล็ก: weekly open · prev week high/low · เลขกลม $100 — ใช้เป็นเป้า TP และจุดคาด reaction',
            'XAGUSD ใช้คอนเฟิร์มเผ่า: silver นำขึ้น = ขาขึ้นโลหะแข็งแรง · ทองขึ้นเดี่ยว silver ไม่ตาม = ขาที่เปราะ',
        ],
        sets: [
            { symbol: 'XAUUSD', tf: '1h', nBars: 400 },
            { symbol: 'XAUUSD', tf: '4h', nBars: 360 },
            { symbol: 'XAUUSD', tf: '1d', nBars: 300 },
            { symbol: 'DXY', tf: '4h', nBars: 300 },
            { symbol: 'DXY', tf: '1d', nBars: 300 },
            { symbol: 'US10Y', tf: '1d', nBars: 300 },
            { symbol: 'VIX', tf: '1d', nBars: 300 },
            { symbol: 'WTI', tf: '1d', nBars: 300 },
            { symbol: 'BTCUSDT', tf: '1d', nBars: 300 },
            { symbol: 'SPY', tf: '1d', nBars: 300 },
            { symbol: 'XAGUSD', tf: '1d', nBars: 300 },
        ],
    },
    position: {
        ttl: 900,
        news: 25,
        rrMin: 2.5,
        horizon: 'ถือหลายสัปดาห์ถึงหลายเดือน',
        tfRoles: '1d = จังหวะสะสม · 1w = TF สั่งการเทรนด์หลัก',
        slGuide: 'SL ใต้โครงสร้างรายสัปดาห์ (swing low 1w · ≈1.0–1.5 × ATR14(1w)) · ทยอยเข้า 3-4 ไม้ไม่ยิงครั้งเดียว',
        playbook: [
            'ทิศหลักมาจากโครงสร้าง 1W เป็นหลัก (แท่งปิดรายสัปดาห์เหนือ/ใต้ EMA20W) · ระบอบ real yield ใช้เป็นตัวประกอบรองเท่านั้น — corr เก่า −0.82 แตกตั้งแต่ 2022 เพราะธนาคารกลางซื้อสะสม (~225 ตัน/ไตรมาส) เป็นผู้ขับราคาแทน ETF flow: yields ขึ้นไม่ใช่เหตุผลขาย แต่ yields ลงยังเป็นเหตุผลซื้อ (asymmetric)',
            'เข้าเป็นไม้ ๆ ที่ pullback รายวันลึก (Fib 50-61.8 ของขา 1W) — ไม้แรกเมื่อแตะโซน ไม้ถัดไปเมื่อมีแท่งกลับตัวรายวัน/รายสัปดาห์ยืนยัน',
            'GDX ใช้เป็น lead indicator: เหมืองแรงกว่าทอง = สถาบันวางเดิมพันขาขึ้นต่อ · เหมืองอ่อนกว่าทองต่อเนื่อง = ขาขึ้นใกล้หมดแรง',
            'โหมดนี้ event เดี่ยวไม่เปลี่ยนทิศ — สิ่งที่เปลี่ยนทิศคือรอบนโยบาย Fed ทั้งชุด: จุดกลับของ cycle (เริ่มลด/เริ่มขึ้นดอกเบี้ย) คือจุดทบทวน thesis ทุกครั้ง',
        ],
        sets: [
            { symbol: 'XAUUSD', tf: '1d', nBars: 300 },
            { symbol: 'XAUUSD', tf: '1w', nBars: 200 },
            { symbol: 'DXY', tf: '1w', nBars: 200 },
            { symbol: 'US10Y', tf: '1w', nBars: 200 },
            { symbol: 'XAGUSD', tf: '1w', nBars: 200 },
            { symbol: 'GDX', tf: '1d', nBars: 300 },
            { symbol: 'GDX', tf: '1w', nBars: 200 },
        ],
    },
};

/** ข้อความ Output 5 (ตัวประกอบ) ของทอง — แยกออกมาให้โปรไฟล์ตราสารอื่นแทนที่ได้ */
export const ANALYSIS_COMPANION_BRIEF_XAU =
    'สรุปผลของแต่ละตัวประกอบต่อทองในโหมดนี้: DXY (สวนทาง), US10Y (สวนทางผ่าน real yield), VIX (กลัว=หนุนทอง), USDJPY (การแทรกแซง/ safe-haven flow), SPY (risk appetite), WTI (เงินเฟ้อ), BTC (คู่แข่ง hedge), XAGUSD (คอนเฟิร์มเผ่าโลหะ), GDX (เหมืองนำ/ตาม) — ตัวไหนหนุน ตัวไหนขัด สุทธิแล้วเข้าข้างฝั่งไหน';

export const ANALYSIS_REQUEST = (
    spec: GoldModeSpec,
    mode: string,
    companionBrief: string = ANALYSIS_COMPANION_BRIEF_XAU,
    assetName_th = 'ทอง',
): Array<[string, string]> => [
    ['Mode', `${mode} — ${spec.horizon} · TF: ${spec.tfRoles}`],
    [
        'Output 1 — Bias',
        'สรุปทิศต่อ TF (ขึ้น/ลง/ข้าง) + เหตุผลจากโครงสร้างราคา EMA stack, RSI, CMF, แนวรับ-ต้าน, แท่งล่าสุด',
    ],
    [
        'Output 2 — Order',
        "ต้องเลือกหนึ่งเดียวชัดเจน: BUY LIMIT @ราคา / BUY STOP @ราคา / SELL LIMIT @ราคา / SELL STOP @ราคา — หรือ NO-TRADE (ไม่ควรเล่นรอบนี้) พร้อมเหตุผล · ห้ามตอบกำกวมว่า 'ซื้อได้ขายได้'",
    ],
    [
        'Output 3 — Levels',
        `Entry zone + SL + TP1 + TP2 เป็นตัวเลขทั้งหมด · ${spec.slGuide} · R:R ขั้นต่ำ ${spec.rrMin}:1 — ต่ำกว่านี้ให้ตอบ NO-TRADE · จุดเข้าต้องอ้างอิง setup ใน ENTRY_PLAYBOOK ด้านล่างอย่างน้อยหนึ่งข้อ ถ้าราคาปัจจุบันไม่เข้าเกณฑ์ setup ไหนเลย = NO-TRADE รอ`,
    ],
    ['Output 4 — Invalidation', 'เงื่อนไขที่ทำให้ setup ตาย (ราคา/เหตุการณ์) — แตะแล้วยกเลิกออเดอร์ค้างทันที'],
    ['Output 5 — Companions', companionBrief],
    [
        'Output 6 — News',
        `ข่าวใน LATEST_FINANCIAL_NEWS ที่กระทบ${assetName_th} + เวลาข่าวใหญ่ข้างหน้า (Fed/CPI/jobs) — ถ้ามี event ใหญ่ภายใน horizon ให้ลดขนาดหรือ NO-TRADE`,
    ],
    [
        'Output 7 — Size & Confidence',
        'ขนาดไม้แนะนำ (เต็ม/ครึ่ง/หนึ่งในสี่) ตาม ATR และ confidence 0-10 พร้อมเหตุผลบรรทัดเดียว',
    ],
    [
        'Output 8 — Summary',
        'สรุปเป็นภาษาคน 3-5 บรรทัด: เล่นหรือไม่เล่น เพราะอะไร แผน A (ตามคำสั่งหลัก) และแผน B (ถ้าราคาวิ่งอีกทาง)',
    ],
];

export const SESSION_MAP: Array<[string, string]> = [
    ['Asia', '06:00–14:00 ไทย (19:00–03:00 ET) — เงียบ สร้างกรอบวัน (Asian range) ใช้เป็นโครงให้ London เล่น'],
    ['London open', '14:00 ไทย (03:00 ET) — แรงขยับแรกของวัน มัก break/reject กรอบเอเชีย'],
    [
        'London–NY overlap',
        '19:00–23:00 ไทย (08:00–12:00 ET) — volume+volatility สูงสุดของวัน · ช่วงทำเงินหลักของ scalp/intraday',
    ],
    [
        'US data',
        '19:30 ไทย (08:30 ET) = NFP (ศุกร์แรกของเดือน)/CPI/jobless — timestamp ผันผวนสุดของสัปดาห์ · FOMC 01:00 ไทย (14:00 ET)',
    ],
    ['Dead zone', 'หลังปิด NY 04:00-05:00 ไทย + ก่อนเอเชียตื่น — spread กว้าง SL โดนกวาดง่าย งดเทรด'],
    ['Daily range', 'ทองขยับ $20–50+/วันเป็นปกติ — วางเป้า/SL ให้สมส่วนกับ range จริง ไม่ใช่ความหวัง'],
];

export const READING_GUIDE = (priceSource: string): Array<[string, string]> => [
    [
        'Order Semantics',
        'BUY LIMIT = ตั้งซื้อต่ำกว่าราคาปัจจุบัน (รอย่อ) · BUY STOP = ตั้งซื้อเหนือราคาปัจจุบัน (รอทะลุ) · SELL LIMIT = ตั้งขายเหนือราคาปัจจุบัน (รอเด้ง) · SELL STOP = ตั้งขายต่ำกว่าราคาปัจจุบัน (รอหลุด)',
    ],
    [
        'Volume Caveat',
        'Volume ทุกไฟล์ = tick volume ของ CFD/FX — CMF/OBV/RVOL ใช้เปรียบเทียบ relative เท่านั้น อย่าตีความเป็นเงินสถาบันแบบหุ้น',
    ],
    [
        'Multi-TF Rule',
        'TF ใหญ่บอกทิศ TF เล็กบอกจังหวะ — ถ้าขัดกันให้ลดขนาดหรือ NO-TRADE · สัญญาณจากแท่งที่ยังไม่ปิด (Is_Closed_Bar=False) ห้ามใช้ยืนยัน',
    ],
    [
        'Correlation Playbook',
        'ทองแพ้เมื่อ: DXY แข็ง + real yield ขึ้น + risk-on เต็มตัว · ทองชนะเมื่อ: ดอลลาร์อ่อน + yields ลง + ความกลัว (VIX ขึ้น) หรือเงินเฟ้อเร่ง (WTI ขึ้นแรง) · การแทรกแซงเยน (ขาย USD) มักหนุนทองระยะสั้น',
    ],
    [
        'Session',
        'ตลาดโลหะเปิด ~23 ชม./วัน ปิด 17:00-18:00 ET และสุดสัปดาห์ · สภาพคล่องบางสุดช่วงหลังปิด NY ถึงเปิด Asia — spread กว้าง ระวัง SL โดนกวาด',
    ],
    [
        'Spread Note',
        `ราคา XAUUSD มาจาก ${priceSource} — เป็น feed เดียวกับบัญชีที่ยิงออเดอร์จริง ตั้งระดับด้วยข้อมูลชุดนี้เสมอ อย่าผสมราคาจากแหล่งอื่น · ตัวประกอบมาจาก Yahoo Finance (ต่างแหล่งได้ ใช้ดูทิศเท่านั้น)`,
    ],
];
