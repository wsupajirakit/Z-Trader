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
    blackouts: [{ from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (ข่าว US 08:30)' }],
    fridayCutoff: 12 * 60,
};

const XAU_COMPANIONS: CompanionSpec[] = [
    { sym: 'dxy', wFast: -1, wSlow: -0.75, label_th: 'DXY สวนทอง' },
    {
        sym: 'us10y',
        wFast: -0.75,
        wSlow: -0.4,
        label_th: {
            fast: 'US10Y (real yield) สวนทอง',
            slow: 'US10Y (นน.ลดลง — corr ทอง-yield แตกตั้งแต่ 2022, ธนาคารกลางเป็นผู้ซื้อหลัก)',
        },
    },
    { sym: 'vix', wFast: 0.5, wSlow: 0.5, label_th: 'VIX ขึ้น = กลัว หนุนทอง' },
    { sym: 'usdjpy', wFast: -0.5, wSlow: -0.5, label_th: 'USDJPY แข็ง = ดอลลาร์แข็ง' },
    { sym: 'spy', wFast: -0.5, wSlow: -0.5, label_th: 'SPY risk-on ลดแรงหนุนทอง' },
    { sym: 'wti', wFast: 0.5, wSlow: 0.5, label_th: 'WTI ขึ้น = เงินเฟ้อหนุนทอง' },
    { sym: 'btcusdt', wFast: -0.25, wSlow: -0.25, label_th: 'BTC คู่แข่ง hedge' },
    { sym: 'xagusd', wFast: 1, wSlow: 1, label_th: 'XAG คอนเฟิร์มเผ่าโลหะ' },
    { sym: 'gdx', wFast: 0.75, wSlow: 1, label_th: 'GDX เหมืองนำทอง (ตัวแทน flow จริง)' },
];

const XAU_BRIEF: InstrumentBrief = {
    persona_th:
        'คุณคือหัวหน้าโต๊ะเทรดทองคำ (XAUUSD spot/CFD) ของกองทุน macro ที่เทรดทองมา 15 ปี ผ่านทั้งรอบ 2011, 2020, 2022-25 — อ่าน order flow/liquidity ขาด และเคารพความเสี่ยงเหนือทุกสิ่ง',
    drivers_th: [
        'ดอลลาร์ (DXY) สวนทางทอง corr −0.5..−0.8 — ทองขึ้นพร้อม DXY ขึ้น = ขาที่อ่อนแอ อย่าไล่',
        'Real yield (US10Y − เงินเฟ้อคาดการณ์): ความสัมพันธ์เก่า (−0.82) แตกตั้งแต่ 2022 — ตอนนี้ asymmetric: yields ลง = หนุนทองแรง · yields ขึ้น = กดทองน้อยกว่าเดิม เพราะธนาคารกลาง (จีน/อินเดีย/ตุรกี/โปแลนด์ ~225 ตัน/ไตรมาส) เป็นผู้ซื้อหลักแทน ETF',
        'ความกลัว (VIX/geopolitics/วิกฤตธนาคาร) = หนุนทองในฐานะ safe haven — แต่ช่วง liquidation ใหญ่ (มีนาคม 2020) ทองโดนขายพร้อมหุ้นเพื่อเติม margin ก่อน แล้วค่อยฟื้น',
        'Fed cycle: จุดกลับของวงจร (เริ่มลด/เริ่มขึ้นดอกเบี้ย) คือตัวเปลี่ยนเทรนด์ใหญ่ · FOMC 14:00 ET + แถลง 14:30 ET · dot plot ทุกไตรมาส',
        'ข้อมูล US 08:30 ET (NFP ศุกร์แรก, CPI, PCE, jobless) = นาทีที่ spread ถ่างและ slippage แรงสุดของสัปดาห์',
        'Silver (XAG) และเหมือง (GDX) เป็นตัวคอนเฟิร์มเผ่าโลหะ: ทองขึ้นเดี่ยวโดย silver/เหมืองไม่ตาม = ขาที่เปราะ',
    ],
    behaviour_th: [
        'ช่วงราคาปกติ $20–50+/วัน · ATR14(1d) คือไม้บรรทัดของ SL/TP ไม่ใช่ความหวัง',
        'เลขกลม $50/$100 คือแม่เหล็กและจุดกวาด stop: ราคาหยุด/เด้ง/กลับตัวที่ระดับเหล่านี้อย่างเป็นระบบ — ห้ามวาง SL ตรงเลขกลมพอดี ห้ามตั้ง TP ข้ามเลขกลมถัดไป',
        'Liquidity sweep เป็นนิสัยประจำ: แทงทะลุ high/low ชัด ๆ แล้วดีดกลับเข้ากรอบทันที (sweep + displacement) → ของจริงต้องมี range แท่งกว้าง + ปิดสวนกลับแรง + volume',
        'กรอบเอเชีย (06:00-14:00 ไทย) สร้างโครงวัน → London break/reject → NY ขี่ต่อ — breakout วิ่งเฉลี่ย 1.5–2 เท่าของความกว้างกรอบ',
        'ทองย่อแรงและเร็ว (retrace hard): กำไร +1R ควรล็อกกันทุนทันที',
    ],
    sessions_th: [
        'Asia 06:00–14:00 ไทย: เงียบ สร้าง Asian range',
        'London open 14:00 ไทย (03:00 ET): แรงขยับแรก มัก break/reject กรอบเอเชีย',
        'London–NY overlap 19:00–23:00 ไทย (08:00–12:00 ET): volume+volatility สูงสุด = ช่วงทำเงินหลักของ scalp/intraday',
        'Dead zone 04:00–05:00 ไทย (หลังปิด NY) + ก่อนเอเชียตื่น: spread กว้าง SL โดนกวาดง่าย งดเทรด',
        'ตลาดพักรายวัน 17:00–18:00 ET (rollover) และปิดสุดสัปดาห์ ศุกร์ 17:00 ET → อาทิตย์ 18:00 ET',
    ],
    levels_th: [
        'SL ต้องอยู่พ้นโครงสร้าง (เลย sweep/swing low-high) + buffer spread และไม่ทับเลขกลม — แล้วคุมเงินด้วย position size ไม่ใช่บีบ SL',
        'TP แรกไม่ข้ามเลขกลม/แม่เหล็กถัดไป (prev day high-low, weekly open, leg extreme)',
        'Entry ต้องอยู่ตรงโครงสร้างจริง (retest ขอบกรอบ, แนวที่เพิ่งทะลุ, FVG, Fib 50–61.8 ของ leg) ไม่ใช่กลางอากาศ',
    ],
    risks_th: [
        'False breakout ช่วง London open — ต้องมีแท่ง "ปิด" นอกกรอบ + RVOL ≥ 1.2 ก่อนเชื่อ',
        'ไล่ราคาหลังข่าว 08:30 ET — รอ 15–30 นาทีให้ spread กลับมาปกติ',
        'วาง SL ที่ 1.2×ATR แล้วโดนกวาดก่อนวิ่ง (post-mortem จริง) — ระยะที่ปลอดภัยกว่าคือฝั่งตรงข้ามกรอบ/1.0–1.5×ATR',
        'ไม้ซ้อนทิศเดียวกันหลายไม้แล้วโดน SL พร้อมกัน — ไม้ใหม่ต้องไม่ทับ risk ไม้เดิม',
    ],
    events_th: [
        'NFP ศุกร์แรกของเดือน 08:30 ET · CPI กลางเดือน 08:30 ET · PCE ปลายเดือน · jobless claims ทุกพฤหัส 08:30 ET',
        'FOMC 8 ครั้ง/ปี 14:00 ET (01:00 ไทย) — วัน FOMC ห้ามเปิดไม้ใหม่ก่อนประกาศ',
        'London fix 10:30 / 15:00 London และ COMEX option expiry ปลายเดือน = จุดที่ราคามักแกว่งผิดปกติ',
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
    name_th: 'ทองคำ',
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
    typicalDailyRange_th: '$20–50+ ต่อวัน',
};

// ---------------- Forex ----------------

const FX_SESSION_EU: SessionSpec = {
    scalpWindows: [
        [3 * 60, 5 * 60],
        [8 * 60, 12 * 60],
    ],
    intradayWindow: [150, 12 * 60 + 30],
    blackouts: [{ from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (ข่าว US 08:30 / ECB 08:15)' }],
    fridayCutoff: 12 * 60,
};

const FX_SESSION_GBP: SessionSpec = {
    scalpWindows: [
        [3 * 60, 5 * 60],
        [8 * 60, 12 * 60],
    ],
    intradayWindow: [150, 12 * 60 + 30],
    blackouts: [
        { from: 2 * 60, to: 2 * 60 + 30, label_th: 'news blackout 02:00-02:30 ET (ข้อมูล UK 07:00 London)' },
        { from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (ข่าว US 08:30)' },
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
    blackouts: [{ from: 8 * 60, to: 9 * 60, label_th: 'news blackout 08:00-09:00 ET (ข่าว US 08:30)' }],
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
    name_th: 'ยูโร/ดอลลาร์',
    emoji: '🇪🇺',
    symbolIdEnv: 'FX_EURUSD_SYMBOL_ID',
    digits: 5,
    pip: 0.0001,
    quoteCcy: 'USD',
    round: { step: 0.005, buffer: 0.0003, tpBuffer: 0.0004, label_th: 'big figure/half figure (x.xx00 / x.xx50)' },
    scalp: { min: 0.0008, max: 0.0015, breakCap: 0.0012 },
    session: FX_SESSION_EU,
    companions: [
        { sym: 'dxy', wFast: -1, wSlow: -1, label_th: 'DXY สวน EURUSD (EUR คือ 57% ของตะกร้า DXY)' },
        { sym: 'us10y', wFast: -0.5, wSlow: -0.5, label_th: 'US10Y ขึ้น = ส่วนต่างดอกเบี้ยหนุน USD กด EURUSD' },
        { sym: 'vix', wFast: -0.5, wSlow: -0.5, label_th: 'VIX ขึ้น = risk-off หนีเข้า USD กด EURUSD' },
        { sym: 'spy', wFast: 0.5, wSlow: 0.5, label_th: 'SPY risk-on = USD อ่อน หนุน EURUSD' },
        { sym: 'gbpusd', wFast: 0.75, wSlow: 0.75, label_th: 'GBPUSD เพื่อนร่วมเผ่ายุโรป (corr +0.8)' },
        { sym: 'usdchf', wFast: -0.75, wSlow: -0.75, label_th: 'USDCHF สวนทาง EURUSD เกือบกระจก (corr −0.9)' },
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
    typicalDailyRange_th: '60–90 pips ต่อวัน',
});

export const GBPUSD_PROFILE = fxProfile('GBPUSD', {
    name_th: 'ปอนด์/ดอลลาร์',
    emoji: '🇬🇧',
    symbolIdEnv: 'FX_GBPUSD_SYMBOL_ID',
    digits: 5,
    pip: 0.0001,
    quoteCcy: 'USD',
    round: { step: 0.005, buffer: 0.0003, tpBuffer: 0.0004, label_th: 'big figure/half figure (x.xx00 / x.xx50)' },
    scalp: { min: 0.001, max: 0.002, breakCap: 0.0015 },
    session: FX_SESSION_GBP,
    companions: [
        { sym: 'dxy', wFast: -1, wSlow: -1, label_th: 'DXY สวน GBPUSD' },
        { sym: 'us10y', wFast: -0.5, wSlow: -0.5, label_th: 'US10Y ขึ้น = หนุน USD กด GBPUSD' },
        { sym: 'vix', wFast: -0.75, wSlow: -0.5, label_th: 'VIX ขึ้น = risk-off ปอนด์โดนขายแรงกว่ายูโร' },
        { sym: 'spy', wFast: 0.5, wSlow: 0.5, label_th: 'SPY risk-on หนุนสกุล beta สูงอย่าง GBP' },
        { sym: 'eurusd', wFast: 0.75, wSlow: 0.75, label_th: 'EURUSD เพื่อนร่วมเผ่ายุโรป (corr +0.8)' },
        { sym: 'usdchf', wFast: -0.5, wSlow: -0.5, label_th: 'USDCHF สวนทาง (ตัวแทนความแข็งของ USD ฝั่งยุโรป)' },
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
    typicalDailyRange_th: '80–120 pips ต่อวัน',
});

export const USDJPY_PROFILE = fxProfile('USDJPY', {
    name_th: 'ดอลลาร์/เยน',
    emoji: '🇯🇵',
    symbolIdEnv: 'FX_USDJPY_SYMBOL_ID',
    digits: 3,
    pip: 0.01,
    quoteCcy: 'JPY',
    round: {
        step: 0.5,
        buffer: 0.03,
        tpBuffer: 0.04,
        label_th: 'เลขกลม xx.00 / xx.50 (big figure ทุก 1.00 = ด่านใหญ่)',
    },
    scalp: { min: 0.08, max: 0.15, breakCap: 0.12 },
    session: FX_SESSION_JPY,
    companions: [
        { sym: 'us10y', wFast: 1, wSlow: 1, label_th: 'US10Y = ตัวขับหลัก (ส่วนต่าง yield US−JP) ขึ้นหนุน USDJPY' },
        { sym: 'dxy', wFast: 0.75, wSlow: 0.75, label_th: 'DXY แข็ง หนุน USDJPY' },
        { sym: 'vix', wFast: -0.75, wSlow: -0.75, label_th: 'VIX ขึ้น = risk-off เยนแข็ง (unwind carry) กด USDJPY' },
        { sym: 'spy', wFast: 0.5, wSlow: 0.5, label_th: 'SPY risk-on = carry trade เดินต่อ หนุน USDJPY' },
        { sym: 'nikkei', wFast: 0.5, wSlow: 0.5, label_th: 'Nikkei ขึ้น = risk-on ญี่ปุ่น เยนอ่อน' },
        { sym: 'wti', wFast: 0.25, wSlow: 0.25, label_th: 'น้ำมันแพง = ญี่ปุ่นนำเข้าพลังงาน เยนอ่อน' },
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
    typicalDailyRange_th: '70–120 pips (0.70–1.20 เยน) ต่อวัน',
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
