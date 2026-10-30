/**
 * โปรไฟล์ตราสาร (instrument profile) — ทุกอย่างที่ต่างกันระหว่าง "ทอง" กับ "คู่เงิน"
 * รวมอยู่ที่นี่ที่เดียว: ทศนิยม/pip/ขนาด lot/มูลค่าต่อจุด/เลขกลม/เป้า scalp/
 * ชั่วโมงตลาด/หน้าต่าง session/ตัวประกอบ/โหมด (TF+playbook)/ข่าว/ความรู้สำหรับ prompt
 *
 * กติกาสำคัญ: โปรไฟล์ XAUUSD ต้องให้ค่าเดิมเป๊ะทุกตัว (TA/lot sizing/ชั่วโมงตลาด)
 * เพราะ flow ทองที่ทดสอบจริงบน demo มาแล้วห้ามเปลี่ยนพฤติกรรม — มี regression test คุม
 * (test/instrument-regression.test.js เทียบกับ dist baseline)
 */
import { GoldMode } from '../data/gold-data.service';
import {
    ANALYSIS_COMPANION_BRIEF_XAU,
    GOLD_MODES,
    GoldModeSpec,
    NEWS_FEEDS,
    READING_GUIDE,
    SESSION_MAP,
} from './gold-modes';
import { FX_CONTENT, FX_NEWS_FEEDS } from './fx-modes';
import { FX_HOURS, MarketHoursSpec, METALS_HOURS } from './market-hours';

export type InstrumentKey = 'XAUUSD' | 'EURUSD' | 'GBPUSD' | 'USDJPY';
export const INSTRUMENT_KEYS: InstrumentKey[] = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];

/** every trading mode the bot knows (every profile's `modes` has the same keys as GOLD_MODES) */
export const MODE_KEYS = Object.keys(GOLD_MODES) as GoldMode[];

/** เลขกลมที่ราคาชอบหยุด/เด้ง — TA หลบตอนวาง entry/SL และไม่ตั้ง TP ข้าม */
export interface RoundSpec {
    step: number; // ระยะห่างเลขกลม (ทอง $50 · EURUSD 0.0050 · USDJPY 0.50)
    buffer: number; // ถ้าระดับอยู่ใกล้เลขกลมกว่านี้ ให้ขยับออก (ทอง $1.6)
    tpBuffer: number; // TP ต้องหยุดก่อนเลขกลมเท่านี้ (ทอง $2.0)
    label_th: string; // สำหรับข้อความ/prompt เช่น "$50/$100"
}

/** เป้า scalp สมจริงในหน่วยราคา (ทอง $2–4.5) */
export interface ScalpTargets {
    min: number; // เป้าขั้นต่ำต่อไม้ (ทอง 2.0)
    max: number; // เป้าสูงสุดของ setup sweep (ทอง 4.5)
    breakCap: number; // เพดานเป้าของ setup break-retest (ทอง 4.0)
}

/** หน้าต่างเวลาเป็นนาที ET (0–1439) — ใช้ New York time เพื่อรอด DST */
export interface SessionSpec {
    scalpWindows: Array<[number, number]>;
    intradayWindow: [number, number];
    blackouts: Array<{ from: number; to: number; label_th: string }>;
    /** นาที ET วันศุกร์ที่งดไม้ใหม่ (null = ไม่งด) */
    fridayCutoff: number | null;
}

export interface CompanionSpec {
    sym: string; // key ตัวพิมพ์เล็กตาม series เช่น 'dxy'
    wFast: number; // น้ำหนัก scalp/intraday (+ = ตัวนี้ขึ้นหนุนตราสารขึ้น)
    wSlow: number; // น้ำหนัก swing/position
    label_th: string | { fast: string; slow: string };
}

/** ความรู้เฉพาะตราสารสำหรับ prompt AI — เขียนแบบเทรดเดอร์อาชีพคุยกัน */
export interface InstrumentBrief {
    persona_th: string; // "คุณคือ..." บรรทัดเดียว
    drivers_th: string[]; // อะไรขับราคา (macro)
    behaviour_th: string[]; // นิสัยราคา (range/วัน, เลขกลม, sweep, ฯลฯ)
    sessions_th: string[]; // ช่วงเวลาที่สำคัญ
    levels_th: string[]; // วิธีอ่านระดับราคา/วาง SL-TP ของตราสารนี้
    risks_th: string[]; // กับดักที่เจอบ่อย
    events_th: string[]; // ปฏิทินเหตุการณ์ที่ต้องเลี่ยง/รู้
}

export interface NewsSpec {
    feeds: Array<{ name: string; url: string }>;
    /** คำที่บอกว่าข่าวเกี่ยวกับตราสารนี้ (ตัวพิมพ์เล็ก) — ใช้จัดอันดับ ไม่ใช่กรองทิ้ง */
    keywords: string[];
}

export interface InstrumentProfile {
    key: InstrumentKey;
    name_th: string;
    emoji: string;
    kind: 'metal' | 'fx';
    /** ชื่อ symbol บน cTrader (ใช้ค้น symbolId และส่ง order) */
    symbolName: string;
    /** env ที่ใช้ fix symbolId (ข้ามการค้นหา) */
    symbolIdEnv: string;
    /** symbolId ถ้ารู้แน่ (ทอง IC Markets = 41) — null = ค้นจาก ProtoOASymbolsListReq */
    defaultSymbolId: number | null;
    digits: number; // ทศนิยมของราคา (ทอง 2 · EURUSD 5 · USDJPY 3)
    pip: number; // 1 pip ในหน่วยราคา (ทอง 0.1 · EURUSD 0.0001 · USDJPY 0.01)
    unitsPerLot: number; // ทอง 100 oz · FX 100,000 หน่วยสกุลหลัก
    /**
     * เพดาน lot ของตราสารนี้ — ต้องแยกรายตัว ห้ามใช้ค่าเดียวคุมทุกตราสาร
     *
     * "1 lot" คนละความหมายกัน: ทอง = 100 oz · FX = 100,000 หน่วย
     * ตั้งค่าเดียว (เช่น 0.01) ให้ทองพอดี -> FX จะเล็กจนไร้ความหมาย
     * (วัดจริง 28 ส.ค.: risk $50 อยากได้ EURUSD 0.29 lot แต่โดนบีบเหลือ 0.01
     *  = เสี่ยงจริงแค่ $0.85 หรือ 2% ของงบ ขณะที่ทองใช้งบ 69% พอดี)
     *
     * ค่านี้เป็น "เพดานกันพลาด" ไม่ใช่ตัวคุมความเสี่ยง — ตัวคุมจริงคือ
     * GOLD_RISK_USD_PER_TRADE + checkRiskBudget · จึงตั้งให้สูงกว่าขนาดปกติมาก
     * แต่ยังกันเคสสูตรพังแล้ว lot พุ่ง
     *
     * ตั้งเพดานให้ "ขยับเป็นเงินต่อวัน" ใกล้กัน ไม่ใช่ให้ notional เท่ากัน
     * เพราะทองผันผวนกว่า FX มาก — วัดจริง 28 ส.ค. 2026 (ATR14 รายวัน):
     *     XAUUSD 86.8 จุด = $8,679/วัน/lot   ·   EURUSD 46 pip = $464/วัน/lot   (ต่างกัน ~19 เท่า)
     * FX เพดาน 2 lot   -> EURUSD ขยับได้สูงสุด ~$927/วัน
     * ทองจึงได้ 0.1 lot -> ขยับได้ ~$868/วัน  (≈ เท่ากัน) · notional ~$46k ≈ 2 เท่าของทุน
     * ถ้าใช้ notional เท่ากันแทน (ทอง 0.5 lot) ทองจะเสี่ยงกว่า FX ราว 5 เท่าโดยไม่ตั้งใจ
     *
     * เช็คแล้วว่า 0.1 ไม่บีบ risk sizing: SL แคบสุดที่เจอจริง (2 จุด) ต้องการ 0.075 lot ยังอยู่ใต้เพดาน
     */
    maxLot: number;
    /**
     * โหมดที่ตราสารนี้ "เทรดได้จริง" — undefined = ได้ทุกโหมด
     *
     * เหตุผลที่ต้องมี: lot ต่ำสุดที่ broker รับคือ 0.01 เท่ากันหมด แต่ 0.01 ของแต่ละ
     * ตราสารเสี่ยงเงินไม่เท่ากันเลย · ทอง 0.01 lot = $1 ต่อการวิ่ง 1 จุด พอ SL กว้าง
     * แบบ swing (~35 จุด) ไม้ต่ำสุดก็เสี่ยงไปแล้ว ~$35 — ลดกว่านี้ไม่ได้ทางกายภาพ
     * แปลว่า risk sizing ทำงานไม่ได้: จะตั้งงบเสี่ยง $15 ยังไงก็ได้ $35 อยู่ดี
     * (FX ไม่เจอปัญหานี้เพราะ 0.01 lot เสี่ยงแค่หลักสตางค์ ยังหารลงได้อีกเยอะ)
     *
     * จึงจำกัดทองไว้ที่โหมด SL แคบ (scalp/intraday) ที่ยังคุมงบต่อไม้ได้จริง
     * เปลี่ยนได้ที่ env GOLD_MODES_<KEY> เช่น GOLD_MODES_XAUUSD=scalp,intraday,swing
     */
    tradableModes?: GoldMode[];
    quoteCcy: 'USD' | 'JPY';
    round: RoundSpec;
    scalp: ScalpTargets;
    hours: MarketHoursSpec;
    session: SessionSpec;
    companions: CompanionSpec[];
    /** ตัวนำ (lead indicator) ที่โหมด position ใช้คอนเฟิร์ม เช่น 'gdx' — undefined = ไม่มี */
    leadIndicator?: string;
    modes: Record<GoldMode, GoldModeSpec>;
    /** ข้อความ Output 5 ของ ANALYSIS_REQUEST (ตัวประกอบ) */
    companionBrief_th: string;
    sessionMap: Array<[string, string]>;
    readingGuide: (priceSource: string) => Array<[string, string]>;
    news: NewsSpec;
    brief: InstrumentBrief;
    /** ช่วงราคาต่อวันโดยทั่วไป (ข้อความ) */
    typicalDailyRange_th: string;
}

// ---------------- helpers ใช้ร่วมกันทุกชั้น ----------------

/** USD ที่ได้/เสียต่อ 1 lot เมื่อราคาขยับ 1.0 หน่วย (ทอง = $100) */
export function usdPerUnitMovePerLot(p: InstrumentProfile, price: number): number {
    if (p.quoteCcy === 'USD') return p.unitsPerLot;
    // สกุลอ้างอิงเป็น JPY: กำไรเป็นเยน → แปลงเป็น USD ด้วยราคาปัจจุบัน (USDJPY)
    return price > 0 ? p.unitsPerLot / price : p.unitsPerLot / 150;
}

/** ปัดราคาตามทศนิยมของตราสาร (ทอง 2 ตำแหน่ง = พฤติกรรมเดิม) */
export function roundPrice(p: InstrumentProfile, v: number): number {
    const m = Math.pow(10, p.digits);
    return Math.round(v * m) / m;
}

export function fmtPrice(p: InstrumentProfile, v: number): string {
    return v.toFixed(p.digits);
}

/** ระยะราคา → pips (ทอง $1 = 10 pips) */
export function toPips(p: InstrumentProfile, dist: number): number {
    return Math.round((dist / p.pip) * 10) / 10;
}

export function seriesKey(p: InstrumentProfile, tf: string): string {
    return `${p.key.toLowerCase()}_${tf}`;
}

export function isInstrumentKey(v: string | undefined | null): v is InstrumentKey {
    return !!v && (INSTRUMENT_KEYS as string[]).includes(v.toUpperCase());
}

// ---------------- XAUUSD — ค่าเดิมทั้งหมด ห้ามแก้ตัวเลข ----------------

const XAU_SESSION: SessionSpec = {
    scalpWindows: [
        [3 * 60, 5 * 60],
        [8 * 60, 12 * 60],
    ], // London open 03-05 ET / overlap 08-12 ET
    intradayWindow: [150, 12 * 60 + 30], // 02:30–12:30 ET
    blackouts: [{ from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (US data 08:30)' }],
    fridayCutoff: 12 * 60,
};

const XAU_COMPANIONS: CompanionSpec[] = [
    { sym: 'dxy', wFast: -1, wSlow: -0.75, label_th: 'DXY inverse to gold' },
    {
        sym: 'us10y',
        wFast: -0.75,
        wSlow: -0.4,
        label_th: {
            fast: 'US10Y (real yield) inverse to gold',
            slow: 'US10Y (weight reduced — gold-yield corr broke down since 2022, central banks are the main buyers)',
        },
    },
    { sym: 'vix', wFast: 0.5, wSlow: 0.5, label_th: 'VIX up = fear, supports gold' },
    { sym: 'usdjpy', wFast: -0.5, wSlow: -0.5, label_th: 'USDJPY strong = strong dollar' },
    { sym: 'spy', wFast: -0.5, wSlow: -0.5, label_th: 'SPY risk-on reduces support for gold' },
    { sym: 'wti', wFast: 0.5, wSlow: 0.5, label_th: 'WTI up = inflation supports gold' },
    { sym: 'btcusdt', wFast: -0.25, wSlow: -0.25, label_th: 'BTC competing hedge' },
    { sym: 'xagusd', wFast: 1, wSlow: 1, label_th: 'XAG confirms the metals complex' },
    { sym: 'gdx', wFast: 0.75, wSlow: 1, label_th: 'GDX miners lead gold (proxy for real flow)' },
];

const XAU_BRIEF: InstrumentBrief = {
    persona_th:
        'You are the head of the gold trading desk (XAUUSD spot/CFD) at a macro fund, trading gold for 15 years through the 2011, 2020 and 2022-25 cycles — you read order flow/liquidity expertly and respect risk above all else',
    drivers_th: [
        'The dollar (DXY) moves inverse to gold, corr −0.5..−0.8 — gold rising together with DXY rising = a weak leg, do not chase',
        'Real yield (US10Y − expected inflation): the old relationship (−0.82) broke down in 2022 — now asymmetric: yields down = strong support for gold · yields up = pressures gold less than before, because central banks (China/India/Turkey/Poland ~225 tonnes/quarter) have replaced ETFs as the main buyers',
        'Fear (VIX/geopolitics/banking crises) = supports gold as a safe haven — but during big liquidations (March 2020) gold gets sold along with equities to meet margin first, then recovers',
        'Fed cycle: turning points of the cycle (first cut/first hike) drive major trend changes · FOMC 14:00 ET + press conference 14:30 ET · dot plot every quarter',
        'US data 08:30 ET (NFP first Friday, CPI, PCE, jobless) = the minutes with the widest spreads and worst slippage of the week',
        'Silver (XAG) and miners (GDX) confirm the metals complex: gold rising alone without silver/miners following = a fragile leg',
    ],
    behaviour_th: [
        'Normal range $20–50+/day · ATR14(1d) is the ruler for SL/TP, not hope',
        'Round numbers $50/$100 are magnets and stop-sweep points: price systematically stalls/bounces/reverses at these levels — never place SL exactly on a round number, never set TP beyond the next round number',
        'Liquidity sweeps are routine: a clear spike through a high/low then an immediate snap back into the range (sweep + displacement) → a real one needs a wide-range bar + strong opposite close + volume',
        "The Asian range (06:00-14:00 BKK) builds the day's structure → London break/reject → NY continues — breakouts run on average 1.5–2× the range width",
        'Gold retraces hard and fast: at +1R profit, lock in breakeven immediately',
    ],
    sessions_th: [
        'Asia 06:00–14:00 BKK: quiet, builds the Asian range',
        'London open 14:00 BKK (03:00 ET): first real move, often breaks/rejects the Asian range',
        'London–NY overlap 19:00–23:00 BKK (08:00–12:00 ET): highest volume+volatility = main money-making window for scalp/intraday',
        'Dead zone 04:00–05:00 BKK (after NY close) + before Asia wakes up: wide spreads, SL easily swept, no trading',
        'Daily break 17:00–18:00 ET (rollover) and weekend close Friday 17:00 ET → Sunday 18:00 ET',
    ],
    levels_th: [
        'SL must sit beyond structure (past the sweep/swing low-high) + spread buffer and not on a round number — then control money with position size, not by tightening SL',
        'First TP does not cross the next round number/magnet (prev day high-low, weekly open, leg extreme)',
        'Entry must be at real structure (range-edge retest, freshly broken level, FVG, Fib 50–61.8 of the leg), not in mid-air',
    ],
    risks_th: [
        'False breakouts around London open — require a bar that "closes" outside the range + RVOL ≥ 1.2 before trusting it',
        'Chasing price after 08:30 ET news — wait 15–30 minutes for the spread to normalize',
        'SL placed at 1.2×ATR got swept before the move (real post-mortem) — safer distance is the opposite side of the range/1.0–1.5×ATR',
        'Stacking several trades in the same direction and getting stopped out together — a new trade must not overlap the risk of existing trades',
    ],
    events_th: [
        'NFP first Friday of the month 08:30 ET · CPI mid-month 08:30 ET · PCE end of month · jobless claims every Thursday 08:30 ET',
        'FOMC 8 times/year 14:00 ET (01:00 BKK) — on FOMC day, no new trades before the announcement',
        'London fix 10:30 / 15:00 London and COMEX option expiry at month end = points where price often swings abnormally',
    ],
};

const XAU_NEWS_KEYWORDS = [
    'gold',
    'bullion',
    'xau',
    'precious metal',
    'silver',
    'fed',
    'fomc',
    'powell',
    'rate cut',
    'rate hike',
    'treasury',
    'yield',
    'dollar',
    'inflation',
    'cpi',
    'pce',
    'nonfarm',
    'payroll',
    'jobs report',
    'jobless',
    'central bank',
    'safe haven',
    'tariff',
    'war',
    'geopolit',
    'ทอง',
];

export const XAUUSD_PROFILE: InstrumentProfile = {
    key: 'XAUUSD',
    name_th: 'Gold',
    emoji: '🥇',
    kind: 'metal',
    symbolName: 'XAUUSD',
    symbolIdEnv: 'GOLD_XAU_SYMBOL_ID',
    defaultSymbolId: 41,
    digits: 2,
    pip: 0.1,
    unitsPerLot: 100,
    quoteCcy: 'USD',
    maxLot: 0.1, // ดูที่มาในคอมเมนต์ maxLot ของ interface — คุมด้วยความผันผวน ไม่ใช่ notional
    // SL ของ swing/position กว้างเกินกว่าที่ไม้ต่ำสุด 0.01 lot จะคุมงบได้ (ดู tradableModes)
    tradableModes: ['scalp', 'intraday'],
    round: { step: 50, buffer: 1.6, tpBuffer: 2.0, label_th: '$50/$100' },
    scalp: { min: 2.0, max: 4.5, breakCap: 4.0 },
    hours: METALS_HOURS,
    session: XAU_SESSION,
    companions: XAU_COMPANIONS,
    leadIndicator: 'gdx',
    modes: GOLD_MODES,
    companionBrief_th: ANALYSIS_COMPANION_BRIEF_XAU,
    sessionMap: SESSION_MAP,
    readingGuide: READING_GUIDE,
    news: { feeds: NEWS_FEEDS, keywords: XAU_NEWS_KEYWORDS },
    brief: XAU_BRIEF,
    typicalDailyRange_th: '$20–50+ per day',
};

// ---------------- Forex ----------------

const FX_SESSION_EU: SessionSpec = {
    scalpWindows: [
        [3 * 60, 5 * 60],
        [8 * 60, 12 * 60],
    ],
    intradayWindow: [150, 12 * 60 + 30],
    blackouts: [{ from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (US data 08:30 / ECB 08:15)' }],
    fridayCutoff: 12 * 60,
};

const FX_SESSION_GBP: SessionSpec = {
    scalpWindows: [
        [3 * 60, 5 * 60],
        [8 * 60, 12 * 60],
    ],
    intradayWindow: [150, 12 * 60 + 30],
    blackouts: [
        { from: 2 * 60, to: 2 * 60 + 30, label_th: 'news blackout 02:00-02:30 ET (UK data 07:00 London)' },
        { from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (US data 08:30)' },
    ],
    fridayCutoff: 12 * 60,
};

const FX_SESSION_JPY: SessionSpec = {
    // Tokyo open 19:00–21:00 ET (ช่วงเยนมีชีวิต) + London open + overlap
    scalpWindows: [
        [19 * 60, 21 * 60],
        [3 * 60, 5 * 60],
        [8 * 60, 12 * 60],
    ],
    intradayWindow: [150, 12 * 60 + 30],
    blackouts: [{ from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (US data 08:30)' }],
    fridayCutoff: 12 * 60,
};

const FX_NEWS_COMMON = [
    'fed',
    'fomc',
    'powell',
    'rate cut',
    'rate hike',
    'treasury',
    'yield',
    'dollar',
    'inflation',
    'cpi',
    'pce',
    'nonfarm',
    'payroll',
    'jobs report',
    'jobless',
    'central bank',
    'forex',
    'fx',
    'currency',
    'tariff',
    'risk-off',
    'risk off',
    'risk-on',
];

function fxProfile(
    key: Exclude<InstrumentKey, 'XAUUSD'>,
    o: {
        name_th: string;
        emoji: string;
        symbolIdEnv: string;
        digits: number;
        pip: number;
        quoteCcy: 'USD' | 'JPY';
        round: RoundSpec;
        scalp: ScalpTargets;
        session: SessionSpec;
        companions: CompanionSpec[];
        keywords: string[];
        typicalDailyRange_th: string;
    },
): InstrumentProfile {
    const c = FX_CONTENT[key];
    return {
        key,
        name_th: o.name_th,
        emoji: o.emoji,
        kind: 'fx',
        symbolName: key,
        symbolIdEnv: o.symbolIdEnv,
        defaultSymbolId: null,
        digits: o.digits,
        pip: o.pip,
        unitsPerLot: 100_000,
        quoteCcy: o.quoteCcy,
        maxLot: 2, // 200k หน่วย ≈ $233k notional · เพดานกันพลาด สูงกว่าขนาดใช้จริง (~0.3) หลายเท่า
        round: o.round,
        scalp: o.scalp,
        hours: FX_HOURS,
        session: o.session,
        companions: o.companions,
        modes: c.modes,
        companionBrief_th: c.companionBrief_th,
        sessionMap: c.sessionMap,
        readingGuide: c.readingGuide,
        news: { feeds: [...NEWS_FEEDS, ...FX_NEWS_FEEDS], keywords: [...FX_NEWS_COMMON, ...o.keywords] },
        brief: c.brief,
        typicalDailyRange_th: o.typicalDailyRange_th,
    };
}

export const EURUSD_PROFILE = fxProfile('EURUSD', {
    name_th: 'Euro/US Dollar',
    emoji: '🇪🇺',
    symbolIdEnv: 'FX_EURUSD_SYMBOL_ID',
    digits: 5,
    pip: 0.0001,
    quoteCcy: 'USD',
    round: { step: 0.005, buffer: 0.0003, tpBuffer: 0.0004, label_th: 'big figure/half figure (x.xx00 / x.xx50)' },
    scalp: { min: 0.0008, max: 0.0015, breakCap: 0.0012 },
    session: FX_SESSION_EU,
    companions: [
        { sym: 'dxy', wFast: -1, wSlow: -1, label_th: 'DXY inverse to EURUSD (EUR is 57% of the DXY basket)' },
        {
            sym: 'us10y',
            wFast: -0.5,
            wSlow: -0.5,
            label_th: 'US10Y up = rate differential supports USD, pressures EURUSD',
        },
        { sym: 'vix', wFast: -0.5, wSlow: -0.5, label_th: 'VIX up = risk-off flight to USD, pressures EURUSD' },
        { sym: 'spy', wFast: 0.5, wSlow: 0.5, label_th: 'SPY risk-on = weaker USD, supports EURUSD' },
        { sym: 'gbpusd', wFast: 0.75, wSlow: 0.75, label_th: 'GBPUSD European peer (corr +0.8)' },
        {
            sym: 'usdchf',
            wFast: -0.75,
            wSlow: -0.75,
            label_th: 'USDCHF moves opposite EURUSD, near mirror image (corr −0.9)',
        },
    ],
    keywords: [
        'euro',
        'eur',
        'ecb',
        'lagarde',
        'eurozone',
        'euro zone',
        'germany',
        'german',
        'bund',
        'france',
        'eu ',
        'european',
    ],
    typicalDailyRange_th: '60–90 pips per day',
});

export const GBPUSD_PROFILE = fxProfile('GBPUSD', {
    name_th: 'Pound/US Dollar',
    emoji: '🇬🇧',
    symbolIdEnv: 'FX_GBPUSD_SYMBOL_ID',
    digits: 5,
    pip: 0.0001,
    quoteCcy: 'USD',
    round: { step: 0.005, buffer: 0.0003, tpBuffer: 0.0004, label_th: 'big figure/half figure (x.xx00 / x.xx50)' },
    scalp: { min: 0.001, max: 0.002, breakCap: 0.0015 },
    session: FX_SESSION_GBP,
    companions: [
        { sym: 'dxy', wFast: -1, wSlow: -1, label_th: 'DXY inverse to GBPUSD' },
        { sym: 'us10y', wFast: -0.5, wSlow: -0.5, label_th: 'US10Y up = supports USD, pressures GBPUSD' },
        { sym: 'vix', wFast: -0.75, wSlow: -0.5, label_th: 'VIX up = risk-off, pound sold harder than the euro' },
        { sym: 'spy', wFast: 0.5, wSlow: 0.5, label_th: 'SPY risk-on supports high-beta currencies like GBP' },
        { sym: 'eurusd', wFast: 0.75, wSlow: 0.75, label_th: 'EURUSD European peer (corr +0.8)' },
        {
            sym: 'usdchf',
            wFast: -0.5,
            wSlow: -0.5,
            label_th: 'USDCHF moves opposite (proxy for USD strength on the European side)',
        },
    ],
    keywords: [
        'pound',
        'sterling',
        'gbp',
        'boe',
        'bank of england',
        'bailey',
        'uk ',
        'u.k.',
        'britain',
        'british',
        'gilt',
        'london',
    ],
    typicalDailyRange_th: '80–120 pips per day',
});

export const USDJPY_PROFILE = fxProfile('USDJPY', {
    name_th: 'US Dollar/Yen',
    emoji: '🇯🇵',
    symbolIdEnv: 'FX_USDJPY_SYMBOL_ID',
    digits: 3,
    pip: 0.01,
    quoteCcy: 'JPY',
    round: {
        step: 0.5,
        buffer: 0.03,
        tpBuffer: 0.04,
        label_th: 'Round numbers xx.00 / xx.50 (big figure every 1.00 = major level)',
    },
    scalp: { min: 0.08, max: 0.15, breakCap: 0.12 },
    session: FX_SESSION_JPY,
    companions: [
        {
            sym: 'us10y',
            wFast: 1,
            wSlow: 1,
            label_th: 'US10Y = main driver (US−JP yield spread), rising supports USDJPY',
        },
        { sym: 'dxy', wFast: 0.75, wSlow: 0.75, label_th: 'DXY strong supports USDJPY' },
        {
            sym: 'vix',
            wFast: -0.75,
            wSlow: -0.75,
            label_th: 'VIX up = risk-off, yen strengthens (carry unwind), pressures USDJPY',
        },
        { sym: 'spy', wFast: 0.5, wSlow: 0.5, label_th: 'SPY risk-on = carry trade continues, supports USDJPY' },
        { sym: 'nikkei', wFast: 0.5, wSlow: 0.5, label_th: 'Nikkei up = Japan risk-on, weaker yen' },
        { sym: 'wti', wFast: 0.25, wSlow: 0.25, label_th: 'Expensive oil = Japan imports energy, weaker yen' },
    ],
    keywords: [
        'yen',
        'jpy',
        'boj',
        'bank of japan',
        'ueda',
        'japan',
        'japanese',
        'intervention',
        'kanda',
        'mof',
        'jgb',
        'nikkei',
        'carry trade',
    ],
    typicalDailyRange_th: '70–120 pips (0.70–1.20 yen) per day',
});

export const INSTRUMENTS: Record<InstrumentKey, InstrumentProfile> = {
    XAUUSD: XAUUSD_PROFILE,
    EURUSD: EURUSD_PROFILE,
    GBPUSD: GBPUSD_PROFILE,
    USDJPY: USDJPY_PROFILE,
};

export const DEFAULT_INSTRUMENT: InstrumentKey = 'XAUUSD';

export function getProfile(key: string | undefined | null): InstrumentProfile {
    const k = (key ?? '').toUpperCase();
    return isInstrumentKey(k) ? INSTRUMENTS[k] : INSTRUMENTS[DEFAULT_INSTRUMENT];
}
