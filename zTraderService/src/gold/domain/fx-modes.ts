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
        '06:00–14:00 BKK (19:00–03:00 ET) — Tokyo fix 09:55 JST (07:55 BKK) · non-JPY pairs are usually quiet and build the day range (Asian range)',
    ],
    [
        'Frankfurt/London open',
        '13:00/14:00 BKK (02:00/03:00 ET) — first move of the day, break/reject of the Asian range · European/UK data released 07:00–10:00 London',
    ],
    [
        'London–NY overlap',
        '19:00–23:00 BKK (08:00–12:00 ET) — highest volume/volatility of the day · US data 08:30 ET · NY option cut 10:00 ET (large strikes pull price)',
    ],
    ['London fix', '22:00 BKK (11:00 ET / 16:00 London) — month-end/quarter-end flows cause unusually large swings'],
    [
        'Dead zone',
        'After 12:00 ET until Tokyo opens — thin liquidity, spread widens around rollover 17:00 ET · no new trades',
    ],
    ['Daily range', pairNote],
];

const FX_READING_GUIDE =
    (corr: string, spreadNote: string) =>
    (priceSource: string): Array<[string, string]> => [
        [
            'Order Semantics',
            'BUY LIMIT = buy below the current price (wait for a dip) · BUY STOP = buy above the current price (wait for a breakout) · SELL LIMIT = sell above the current price (wait for a bounce) · SELL STOP = sell below the current price (wait for a breakdown)',
        ],
        [
            'Volume Caveat',
            'Volume in every file = FX/CFD tick volume — use CMF/OBV/RVOL for relative comparison only (forex has no centralized volume)',
        ],
        [
            'Multi-TF Rule',
            'Higher TF gives direction, lower TF gives timing — if they conflict, reduce size or NO-TRADE · never use signals from unclosed bars (Is_Closed_Bar=False) as confirmation',
        ],
        ['Correlation Playbook', corr],
        [
            'Session',
            'Forex trades 24/5: Sun 17:05 ET → Fri 16:55 ET · no daily break, but spread widens 2–5x around rollover 17:00 ET · thinnest liquidity after NY close until Tokyo opens',
        ],
        [
            'Spread Note',
            `Major pair prices come from ${priceSource} — the same feed as the account that places live orders; always set levels from this data set · ${spreadNote} · companions come from Yahoo Finance (may be a different source; use for direction only)`,
        ],
    ];

// ======================= EURUSD =======================

const EURUSD_MODES: Record<GoldMode, GoldModeSpec> = {
    scalp: {
        ttl: 60,
        news: 10,
        rrMin: 1.5,
        horizon: 'In and out within 1–4 hours',
        tfRoles: '5m = execution TF (entry/SL) · 15m = context TF (direction/liquidity pools)',
        slGuide:
            'SL beyond the sweep point + 1–2 pips spread · or 0.5–0.8 × ATR14(5m) · never place exactly on a big figure/half figure (x.xx00 / x.xx50)',
        playbook: [
            'Primary setup A — Liquidity Sweep: price spikes through the prior session high/low or a 00/50 level, then closes back inside the range immediately (sweep + displacement: wide bar ≥1.1×ATR · strong reversal close · RVOL ≥1.3) → enter on the retest of the just-reclaimed level · target = opposite-side pool · SL 0.5–0.8×ATR beyond the sweep',
            'Primary setup B — Asian range break-retest: at London open (14:00 BKK / 03:00 ET) price breaks the Asian range (usually 20–40 pips) then pulls back to retest the edge → enter in the breakout direction · abnormally narrow range (<0.5×ATR 1h) = unreliable breakout, wait',
            'Money-making windows: London open 14:00–16:00 BKK and overlap 19:00–23:00 BKK (08:00–12:00 ET) — outside these windows spreads are wide and signals unreliable = NO-TRADE',
            'Round numbers: EURUSD stalls/bounces at the 00 and 50 pip levels (e.g. 1.0800 / 1.0850) because option strikes and institutional orders cluster there — first TP must not cross the next figure · for entries near a figure, wait for the sweep rather than front-running · NY option cut 10:00 ET: large strikes "pull" price',
            'Realistic target per trade: 8–15 pips · news 08:30 ET (US) and ECB 08:15 ET (Thursday every 6 weeks) = NO-TRADE ±30 min · European PMI flash 03:15–04:00 ET makes London open more volatile than usual',
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
        horizon: 'Hold for hours to overnight (1–4 h or more)',
        tfRoles: '15m/30m = entry timing · 1h = direction TF',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) or below/above the opposite edge of the Asian range · avoid 00/50',
        playbook: [
            'The core game is the 3-session cycle: Asia (06:00–14:00 BKK) builds the day range of 20–40 pips → London (14:00 BKK) breaks or rejects the range → rides on into NY (19:30 BKK) — standard target 1.5–2x the range width · on a normal day EURUSD moves 60–90 pips',
            'Setup A — London break: break of Asian high/low + 15m/30m bar closes outside the range + RVOL ≥1.2 + retest holds → enter on the retest of the range edge (LIMIT)',
            'Setup B — London reject (fade): spike through the range then close back inside (fake breakout — EURUSD does this often 03:00–04:00 ET before PMI) → fade toward the opposite range edge, half the size of Setup A',
            'NY 08:30 ET data is the midday acceleration/reversal point — hold through it only with trades already in profit with a buffer; new trades wait 15–30 min after the news · the 10:00 ET option cut often pulls price back to large strikes before releasing · FOMC/ECB days = do not open before the announcement',
            'Always check intraday direction against DXY 1h (EUR = 57% of DXY, so it is nearly a mirror) + US10Y: US yields spiking = USD strong, pressures EURUSD — if EURUSD rises together with DXY = weak leg, do not chase',
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
        horizon: 'Hold for several days to several weeks',
        tfRoles: '1h = entry timing · 4h = structure · 1d = primary direction TF',
        slGuide:
            'SL below/above the swing low/high of the pullback used for entry, always (not a floating ATR, not a figure) · check width ≈ 1.0–1.5 × ATR14(1d) (~60–100 pips)',
        playbook: [
            'Core structure (trend-pullback): use 4H EMA50 vs EMA200 as trend filter (50>200 = BUY side only) → wait for a pullback into a zone: EMA20/50 4H · Fib 38.2/50/61.8 of the latest leg (61.8–78.6 = OTE, best RR) · or an old figure turned support',
            'Enter only with confirmation: reversal bar (hammer/engulfing) on 1H–4H · RSI divergence · or break of the pullback minor trendline — no confirmation = a LIMIT at the zone is allowed but at half size',
            'Macro overlay before deciding direction: the weekly driver of EURUSD is the "rate differential" Fed vs ECB (US2Y − DE2Y) and DXY (corr ≈ −0.95) · ECB moves before the Fed = euro weak · expensive energy = Europe loses trade balance, euro weak · big risk-off = USD strong, euro weak · extreme one-sided CFTC positioning = squeeze risk',
            'Magnet levels: weekly open · prev week high/low · big figures every 100 pips (1.05/1.10/1.15) · monthly option barrier — use as TP targets and expected reaction points',
            'Use GBPUSD/USDCHF as family confirmation: EURUSD up with GBPUSD following and USDCHF down = genuine broad USD weakness · EURUSD rising alone = a euro-specific (ECB) story, more fragile',
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
        horizon: 'Hold for several weeks to several months',
        tfRoles: '1d = accumulation timing · 1w = primary trend TF',
        slGuide:
            'SL below the weekly structure (swing low 1w · ≈1.0–1.5 × ATR14(1w) ~150–250 pips) · scale in over 3-4 entries, not all at once',
        playbook: [
            'Primary direction comes from 1W structure (weekly close above/below EMA20W) · the monthly EURUSD trend follows the "policy cycle" — whoever starts cutting rates first/faster has the weaker currency · the 2-year US−DE yield spread is the compass',
            'Scale in on deep daily pullbacks (Fib 50–61.8 of the 1W leg) — first entry when the zone is touched, next entries when a daily/weekly reversal bar confirms',
            'Leading signal: weekly DXY makes a new high but EURUSD does not make a new low = bullish divergence (someone is buying euros) · USDCHF not confirming = USD weakness not broad-based, be careful',
            'In this mode a single event does not change direction — what changes it is a Fed/ECB cycle turning point, a European energy crisis, or an EU political shock (French/Italian elections) → re-check the thesis every time',
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
        'You are the head of the G10 FX desk at an investment bank, trading EURUSD for 15 years through the 2012 eurozone crisis, ECB QE and the 2022 parity leg — you read flows/option strikes/rate differentials expertly and respect risk above all else',
    drivers_th: [
        'The Fed vs ECB rate differential (US2Y − DE2Y) is the main weekly-to-monthly driver · the market trades cycle "expectations", not current figures',
        'DXY is the mirror image (EUR = 57.6% of the basket) corr ≈ −0.95 — read DXY before reading the euro',
        'Risk sentiment: big risk-off = USD strong (safe haven), euro weak · risk-on = EURUSD up together with SPY',
        'European data: PMI flash (03:15–04:00 ET), HICP inflation, German IFO/ZEW, ECB every 6 weeks (Thu 08:15 ET + press conference 08:45 ET)',
        'US data 08:30 ET (NFP/CPI/PCE) and FOMC 14:00 ET hit just as hard because USD is half of the pair',
        'Energy prices: Europe imports energy — expensive oil/gas = euro weak (clearly seen in 2022)',
    ],
    behaviour_th: [
        'Normal range 60–90 pips/day · spread 0.1–0.5 pip during London/NY but widens around rollover 17:00 ET and news',
        'Round numbers 00/50 (e.g. 1.0800/1.0850) = option strikes and institutional orders cluster → price stalls/bounces/sweeps stops here · NY option cut 10:00 ET: large strikes pull price like a magnet',
        'Narrow Asian range (20–40 pips) → London open break/reject · false breakouts 03:00–04:00 ET are very common, wait for a bar close + volume',
        'EURUSD trends "slow but long" on higher TFs: big legs run several hundred pips over months but repeatedly pull back into EMA/Fib zones, offering entries',
        'Month/quarter-end London fix 11:00 ET rebalancing flows temporarily push price against structure',
    ],
    sessions_th: [
        'Asia 06:00–14:00 BKK: quiet, builds the Asian range',
        'Frankfurt 13:00 BKK / London 14:00 BKK (02:00/03:00 ET): first move, break/reject of the Asian range · European data released in this window',
        'London–NY overlap 19:00–23:00 BKK (08:00–12:00 ET): highest volume · 08:30 ET US news · 10:00 ET option cut',
        'After 12:00 ET: liquidity drops, the daily trend often stalls · spread widens at rollover 17:00 ET',
        'Market 24/5: Sun 17:05 ET → Fri 16:55 ET',
    ],
    levels_th: [
        'SL must sit beyond structure (past the sweep/swing) + 1–2 pips spread and not on 00/50 — control money with lot size, not by squeezing the SL',
        'First TP must not cross the next figure/half-figure, nor prev day high/low · weekly open',
        'Entry must be at structure: retest of the range edge, a just-reclaimed level, Fib 50–61.8 of the leg, EMA20/50 4H',
        'Value: 1 lot = €100,000 → 1 pip = $10 · SL 30 pips at 0.1 lot = $30 at risk',
    ],
    risks_th: [
        'False breakout at London open — require a 15m bar close outside the range + RVOL ≥1.2',
        'Chasing price after 08:30 ET — wait 15–30 min',
        'Trading against DXY: EURUSD up but DXY not down = fake leg',
        'Forgetting ECB/Fed day: price runs 100+ pips in a minute, SL swept with slippage',
    ],
    events_th: [
        'ECB every 6 weeks, Thu 08:15 ET (press conference 08:45 ET) · FOMC 14:00 ET',
        'US: NFP first Friday, CPI mid-month, PCE month-end, jobless Thursday — all 08:30 ET',
        'Europe: PMI flash ~23rd of the month 03:15–04:00 ET · HICP flash month-end 05:00 ET · German IFO/ZEW',
        'NY option cut 10:00 ET daily · London fix 11:00 ET (strong at month-end)',
    ],
};

// ======================= GBPUSD =======================

const GBPUSD_MODES: Record<GoldMode, GoldModeSpec> = {
    scalp: {
        ttl: 60,
        news: 10,
        rrMin: 1.5,
        horizon: 'In and out within 1–4 hours',
        tfRoles: '5m = execution TF (entry/SL) · 15m = context TF (direction/liquidity pools)',
        slGuide:
            'SL beyond the sweep point + 2–3 pips spread (cable spread is wider than EURUSD) · or 0.5–0.8 × ATR14(5m) · never place exactly on 00/50',
        playbook: [
            'Primary setup A — Liquidity Sweep: cable sweeps stops harder than EURUSD — price spikes through the prior session high/low or a 00/50 level then closes back immediately (wide bar ≥1.1×ATR · strong reversal close · RVOL ≥1.3) → enter on the retest of the reclaimed level · target the opposite-side pool · SL 0.5–0.8×ATR beyond the sweep',
            'Primary setup B — Asian range break-retest: London open (14:00 BKK / 03:00 ET) breaks the Asian range then retests the edge → enter in that direction · GBP has UK data at 07:00 London (02:00 ET) before London open — if the news just came out, wait for a clear bar close first',
            'Money-making windows: London open 14:00–16:00 BKK and overlap 19:00–23:00 BKK — outside these windows spread is 1–2 pips+, signals unreliable = NO-TRADE',
            'Round numbers: 00/50 (e.g. 1.2700/1.2750) and big figures every 100 pips — first TP must not cross the next figure · near a figure, wait for the sweep first',
            'Realistic target per trade: 10–20 pips (cable moves ~30% more than EURUSD) · news 08:30 ET (US) and 02:00 ET (UK CPI/GDP/jobs) = NO-TRADE ±30 min · BoE Thu 07:00 ET = stand aside before the announcement',
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
        horizon: 'Hold for hours to overnight (1–4 h or more)',
        tfRoles: '15m/30m = entry timing · 1h = direction TF',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) or below/above the opposite edge of the Asian range · avoid 00/50',
        playbook: [
            'The core game is the 3-session cycle: Asia (06:00–14:00 BKK) builds a 25–50 pip range → London (14:00 BKK) break/reject → rides on into NY — standard target 1.5–2x the range · on a normal day cable moves 80–120 pips',
            'Setup A — London break: break of Asian high/low + 15m/30m bar closes outside the range + RVOL ≥1.2 + retest holds → enter on the retest of the range edge (LIMIT)',
            'Setup B — London reject (fade): spike through then close back inside (cable makes fake breakouts hard and often) → fade toward the opposite range edge, half the size of Setup A',
            'NY 08:30 ET data = acceleration/reversal point · UK data 02:00 ET can set direction for the whole day · BoE day (Thu 07:00 ET): do not open before the announcement · same for FOMC 14:00 ET',
            'Check intraday direction against DXY 1h and EURUSD 1h: cable up together with EURUSD up = a USD-weakness story (genuine) · cable up alone = a GBP story (BoE/UK data), more fragile — if GBPUSD rises together with DXY = weak leg, do not chase',
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
        horizon: 'Hold for several days to several weeks',
        tfRoles: '1h = entry timing · 4h = structure · 1d = primary direction TF',
        slGuide:
            'SL below/above the swing low/high of the pullback used for entry, always · check width ≈ 1.0–1.5 × ATR14(1d) (~80–130 pips)',
        playbook: [
            'Core structure (trend-pullback): 4H EMA50 vs EMA200 as trend filter → wait for a pullback into the EMA20/50 4H zone · Fib 38.2/50/61.8 of the latest leg (61.8–78.6 = OTE) · or an old figure turned support',
            'Enter only with confirmation: reversal bar on 1H–4H · RSI divergence · break of the minor trendline — no confirmation = LIMIT at the zone at half size',
            'Macro overlay: the weekly driver is the Fed vs BoE rate differential + risk sentiment (GBP is a high-beta currency: sold harder than EUR in risk-off) · UK fiscal credibility (gilt market — the 2022 crisis is the lesson) · energy prices · extreme CFTC positioning = squeeze risk',
            'Magnet levels: weekly open · prev week high/low · big figures every 100 pips (1.25/1.30/1.35) · option barrier',
            'Use EURUSD/USDCHF as family confirmation: cable up with EURUSD following and USDCHF down = broad USD weakness · cable up alone = a pure GBP story, check BoE/UK news as well',
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
        horizon: 'Hold for several weeks to several months',
        tfRoles: '1d = accumulation timing · 1w = primary trend TF',
        slGuide:
            'SL below the weekly structure (swing low 1w · ≈1.0–1.5 × ATR14(1w) ~200–300 pips) · scale in over 3-4 entries',
        playbook: [
            'Primary direction from 1W structure (weekly close above/below EMA20W) · the monthly cable trend follows the Fed vs BoE cycle and UK "fiscal credibility"',
            'Scale in on deep daily pullbacks (Fib 50–61.8 of the 1W leg) — first entry when the zone is touched, next entries when a daily/weekly reversal bar confirms',
            'Leading signal: weekly DXY new high but cable does not make a new low = bullish divergence · EURUSD not confirming = a GBP-specific story, be careful',
            'In this mode a single event does not change direction — what changes it is a Fed/BoE cycle turning point, the UK budget (Autumn/Spring statement), or a political shock → re-check the thesis',
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
        'You are the head of a G10 FX desk in London, trading cable (GBPUSD) for 15 years through Brexit 2016, the October 2016 flash crash and the 2022 gilt crisis — you know sterling sweeps stops harder and faster than other pairs, so you respect risk above all else',
    drivers_th: [
        'Fed vs BoE rate differential and cycle expectations · BoE meets 8 times/year, Thu 12:00 London (07:00 ET)',
        'Risk sentiment: GBP is a high-beta currency — sold harder than EUR in risk-off · rallies harder in risk-on',
        'DXY (corr ≈ −0.85) and EURUSD (corr ≈ +0.8) — distinguish whether it is a USD story or a GBP story',
        'UK fiscal/political confidence: gilt market turmoil = sterling drops immediately (September 2022)',
        'UK data 07:00 London (02:00 ET): CPI, GDP, wages/employment, retail sales — can set the day direction',
        'US data 08:30 ET and FOMC 14:00 ET hit equally hard because USD is half of the pair',
    ],
    behaviour_th: [
        'Normal range 80–120 pips/day (~30% more than EURUSD) · spread ~2x wider than EURUSD',
        'Sweeps stops at 00/50 and swing highs/lows hard and often — sweep-then-reverse is its habit',
        'Asian range 25–50 pips → London open break/reject · fake breakouts very common 03:00–04:00 ET',
        'The daily trend usually runs from London open to 11:00 ET (London fix) and then fades',
        'Month-end London fix 11:00 ET: unusually strong flows',
    ],
    sessions_th: [
        'Asia 06:00–14:00 BKK: quiet, builds the Asian range',
        'UK data 14:00 BKK (02:00 ET) → London open 15:00 BKK (03:00 ET): first move',
        'London–NY overlap 19:00–23:00 BKK (08:00–12:00 ET): highest volume · 08:30 ET US news · 10:00 ET option cut',
        'After London fix 22:00 BKK (11:00 ET): liquidity drops, trend stalls · spread widens at rollover 17:00 ET',
        'Market 24/5: Sun 17:05 ET → Fri 16:55 ET',
    ],
    levels_th: [
        'SL beyond structure + 2–3 pips spread and not on 00/50 — cable needs more room than EURUSD',
        'First TP must not cross the next figure/half-figure · prev day high/low · weekly open',
        'Entry at structure: retest of the range edge, reclaimed level, Fib 50–61.8, EMA20/50 4H',
        'Value: 1 lot = £100,000 → 1 pip = $10 · SL 40 pips at 0.1 lot = $40 at risk',
    ],
    risks_th: [
        'Fake breakout at London open — wait for a 15m bar close + RVOL ≥1.2',
        'UK data 02:00 ET comes out before London open — orders left overnight can get swept',
        'Trading against DXY/EURUSD: cable rising alone = pure GBP story, more fragile',
        'BoE/FOMC days: 100+ pips in a minute · days with both UK and US data = two volatility bursts',
    ],
    events_th: [
        'BoE Thu 07:00 ET (8 times/year) · FOMC 14:00 ET',
        'UK: CPI mid-month 02:00 ET · jobs/wages mid-month 02:00 ET · monthly GDP · retail sales',
        'US: NFP first Friday, CPI, PCE, jobless — 08:30 ET',
        'NY option cut 10:00 ET · London fix 11:00 ET · UK budget (Autumn/Spring statement)',
    ],
};

// ======================= USDJPY =======================

const USDJPY_MODES: Record<GoldMode, GoldModeSpec> = {
    scalp: {
        ttl: 60,
        news: 10,
        rrMin: 1.5,
        horizon: 'In and out within 1–4 hours',
        tfRoles: '5m = execution TF (entry/SL) · 15m = context TF (direction/liquidity pools)',
        slGuide:
            'SL beyond the sweep point + 1–2 pips spread · or 0.5–0.8 × ATR14(5m) · never place exactly on xx.00 / xx.50',
        playbook: [
            'Primary setup A — Liquidity Sweep: price spikes through the prior session high/low or a .00/.50 level then closes back inside immediately (wide bar ≥1.1×ATR · strong reversal close · RVOL ≥1.3) → enter on the retest of the reclaimed level · target the opposite-side pool · SL 0.5–0.8×ATR beyond the sweep · USDJPY gets swept often around the Tokyo fix 09:55 JST (07:55 BKK)',
            'Primary setup B — Asian range break-retest: unlike the European pairs — Tokyo is the main yen session, so the Asian range is wide and carries real flow (gotobi days 5/10/15/20/25/30: importers buy USD into the fix) · London open (03:00 ET) breaks the range then retests the edge → enter in that direction',
            'Money-making windows: Tokyo open 06:00–08:00 BKK (19:00–21:00 ET) · London open 14:00–16:00 BKK · overlap 19:00–23:00 BKK — outside these windows (especially after NY close) NO-TRADE',
            'Round numbers: xx.00 and xx.50 are barriers (option barrier + stops) · big figures every 1.00 yen · "political" levels 150/155/160 = zones where MoF has intervened — BUY entries near these zones must reduce size or stand aside',
            'Realistic target per trade: 8–15 pips (0.08–0.15 yen) · news 08:30 ET (US) = NO-TRADE ±30 min · BoJ announces 22:30–00:30 ET with no fixed time — on BoJ days no scalping during Tokyo · "rate check"/MoF warnings = intervention signal, close BUY trades immediately',
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
        horizon: 'Hold for hours to overnight (1–4 h or more)',
        tfRoles: '15m/30m = entry timing · 1h = direction TF',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) or below/above the opposite edge of the Asian range · avoid .00/.50',
        playbook: [
            'The core game is the 3-session cycle, but the yen differs in that Tokyo (06:00–14:00 BKK) has real flow: gotobi/importers buy USD into the 09:55 JST fix · exporters sell USD above figures — so the Asian range is a "meaningful range" → London break/reject → NY rides on · target 1.5–2x the range · a normal day moves 70–120 pips',
            'Setup A — London break: break of Asian high/low + 15m/30m bar closes outside the range + RVOL ≥1.2 + retest holds → enter on the retest of the range edge (LIMIT) · direction must agree with US10Y 1h (yields up = USDJPY up)',
            'Setup B — London reject (fade): spike through then close back inside → fade toward the opposite range edge, half the size of Setup A',
            'NY 08:30 ET data = acceleration/reversal point (USDJPY reacts to yields more than any other major) · FOMC 14:00 ET · BoJ day (22:30–00:30 ET): do not hold trades without a buffer through it · intervention warnings from MoF/BoJ = close BUY trades',
            'Always check intraday direction against US10Y 1h (corr +0.7..+0.9, the main driver) + DXY + Nikkei/SPY (risk-on = carry continues = USDJPY up · risk-off = carry unwind = sharp drop) — if USDJPY rises but yields fall = weak leg, do not chase',
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
        horizon: 'Hold for several days to several weeks',
        tfRoles: '1h = entry timing · 4h = structure · 1d = primary direction TF',
        slGuide:
            'SL below/above the swing low/high of the pullback used for entry, always · check width ≈ 1.0–1.5 × ATR14(1d) (~100–150 pips)',
        playbook: [
            'Core structure (trend-pullback): 4H EMA50 vs EMA200 as trend filter → wait for a pullback into the EMA20/50 4H zone · Fib 38.2/50/61.8 of the latest leg (61.8–78.6 = OTE) · or an old figure turned support',
            'Enter only with confirmation: reversal bar on 1H–4H · RSI divergence · break of the minor trendline — no confirmation = LIMIT at the zone at half size',
            'Macro overlay: USDJPY tracks the US−JP yield spread (US10Y − JGB10Y) almost one-to-one, corr +0.8 · BoJ exiting easy policy (rate hikes/JGB taper) = structural yen strength · big carry trade: risk-off = fast, violent unwind (August 2024: dropped 12% in 3 weeks) — the BUY side must always have an exit plan · zone 150–162 = MoF intervention history; BUY above this zone at half size',
            'Magnet levels: weekly open · prev week high/low · figures every 1.00 yen · prior intervention levels (151.9 / 157.5 / 160+)',
            'Use Nikkei/SPY to confirm the regime: USDJPY up with Nikkei up and VIX low = healthy carry · USDJPY up while VIX spikes = a leg ready to unwind, very fragile',
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
        horizon: 'Hold for several weeks to several months',
        tfRoles: '1d = accumulation timing · 1w = primary trend TF',
        slGuide:
            'SL below the weekly structure (swing low 1w · ≈1.0–1.5 × ATR14(1w) ~250–400 pips) · scale in over 3-4 entries',
        playbook: [
            'Primary direction from 1W structure (weekly close above/below EMA20W) · the monthly USDJPY trend follows the US−JP yield spread and BoJ policy direction (normalisation = long-term yen strength)',
            'Scale in on deep daily pullbacks (Fib 50–61.8 of the 1W leg) — first entry when the zone is touched, next entries when a daily/weekly reversal bar confirms',
            'Leading signal: weekly US10Y makes a new high but USDJPY does not follow = yen selling is being absorbed (intervention/exporters), be careful on the BUY side · rising VIX baseline = carry about to unwind',
            'In this mode a single event does not change direction — what changes it is actual MoF intervention, a Fed cycle turning point, or a BoJ policy framework change → re-check the thesis every time',
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
        'You are the head of the JPY desk at a Japanese bank in Tokyo, trading USDJPY for 15 years through the 2022/2024 interventions, the August 2024 carry unwind and the BoJ ending YCC — you know the yen is the pair where "policy politics" drives price, so you respect risk above all else',
    drivers_th: [
        'The US−JP yield spread (US10Y − JGB10Y) is the main driver, corr +0.7..+0.9 — USDJPY reacts to US yields more than other majors',
        'BoJ: normalisation (rate hikes/reduced JGB buying) = structural yen strength · meetings have no fixed time (around 22:30–00:30 ET) · Ueda press conference 01:30 ET',
        'MoF/BoJ intervention: verbal warning → rate check → actual intervention (selling tens of billions of USD) drops 3–5 yen within an hour · historical zone 150–162',
        'Carry trade: risk-on = borrow JPY to buy risk assets = USDJPY grinds higher · risk-off = unwind, fast and violent drop (asymmetric)',
        'Real Japanese flows: importers buy USD into the Tokyo fix 09:55 JST (gotobi 5/10/15/20/25/30) · exporters sell USD above figures · GPIF pension fund/life insurers hedge ratios',
        'US data 08:30 ET and FOMC 14:00 ET hit hard via the yields channel · expensive oil = Japan trade deficit, yen weak',
    ],
    behaviour_th: [
        'Normal range 70–120 pips (0.70–1.20 yen)/day · spread very tight during Tokyo/London',
        'Round numbers .00/.50 = option barrier + stops · figures every 1.00 yen are psychological barriers · 150/155/160 = political barriers',
        'Tokyo session has real flow (unlike the quiet EURUSD) — the Asian range is wide and often swept around the 09:55 JST fix',
        'Uptrends climb like stairs (carry) but downtrends drop like an elevator (unwind/intervention) — the BUY side must lock profits faster than the SELL side',
        'Reacts to headlines instantly: the words "intervention / rate check / excessive moves" from MoF = sell first, ask later',
    ],
    sessions_th: [
        'Tokyo 06:00–14:00 BKK (19:00–03:00 ET): main yen session · fix 09:55 JST = 07:55 BKK · BoJ/Japanese data released in this window',
        'London open 14:00 BKK (03:00 ET): break/reject of the Tokyo range',
        'London–NY overlap 19:00–23:00 BKK (08:00–12:00 ET): highest volume · 08:30 ET US news hits via yields',
        'After 12:00 ET until Tokyo opens: thin, spread widens · rollover 17:00 ET (high swap due to the rate differential — holding SELL overnight costs swap)',
        'Market 24/5: Sun 17:05 ET → Fri 16:55 ET',
    ],
    levels_th: [
        'SL beyond structure + 1–2 pips and not on .00/.50 · BUY near the intervention zone (150+) needs a tighter SL or smaller size',
        'First TP must not cross the next figure · prev day high/low · weekly open · prior intervention levels',
        'Entry at structure: retest of the Tokyo range edge, reclaimed level, Fib 50–61.8, EMA20/50 4H',
        'Value: 1 lot = $100,000 → 1 pip (0.01) ≈ $6.5–7 (varies with price: 100,000×0.01/price) · SL 40 pips at 0.1 lot ≈ $27 at risk',
    ],
    risks_th: [
        'Actual intervention: BUY side drops 300–500 pips in 1 hour — above 150 never hold a BUY without an SL',
        'Carry unwind: VIX spikes + Nikkei drops = USDJPY falls faster than ATR suggests',
        'BoJ days: no fixed time, resting orders get swept during Tokyo',
        'Trading against US10Y: USDJPY up but yields down = fake leg',
    ],
    events_th: [
        'BoJ 8 times/year (announcement ~22:30–00:30 ET, press conference 01:30 ET) · FOMC 14:00 ET',
        'US: NFP/CPI/PCE/jobless 08:30 ET · Treasury auction 13:00 ET (yields jump)',
        'Japan: Tokyo CPI month-end 19:30 ET · quarterly Tankan · wages (shunto) in March',
        'Tokyo fix 09:55 JST daily (stronger on gotobi) · NY option cut 10:00 ET · Japanese fiscal year-end (March) repatriation flow',
    ],
};

export const FX_CONTENT: Record<'EURUSD' | 'GBPUSD' | 'USDJPY', FxContent> = {
    EURUSD: {
        modes: EURUSD_MODES,
        companionBrief_th:
            'Net effect of each companion on EURUSD in this mode: DXY (mirror image, inverse), US10Y (US yields up = USD strong, pressures the euro), VIX (fear = USD strong, pressures the euro), SPY (risk-on supports the euro), GBPUSD (family peer, should move the same way), USDCHF (inverse, near mirror) — which support, which conflict, and which side the net favours',
        sessionMap: FX_SESSION_MAP(
            'EURUSD normally moves 60–90 pips/day — size targets/SL in proportion to the real ATR, not hope',
        ),
        readingGuide: FX_READING_GUIDE(
            'EURUSD loses when: DXY strong + US yields rising faster than Bunds + risk-off (VIX up) + expensive energy · EURUSD wins when: DXY weak + ECB more hawkish than the Fed + risk-on (SPY up) · GBPUSD must confirm the same direction and USDCHF must move opposite, otherwise it is a euro-specific story',
            'Normal spread 0.1–0.5 pip, widening to 2–5 pips around rollover/news',
        ),
        brief: EURUSD_BRIEF,
    },
    GBPUSD: {
        modes: GBPUSD_MODES,
        companionBrief_th:
            'Net effect of each companion on GBPUSD in this mode: DXY (inverse), US10Y (US yields up = pressures sterling), VIX (fear = sterling sold hard due to high beta), SPY (risk-on supports sterling), EURUSD (family peer), USDCHF (inverse) — which support, which conflict, and which side the net favours',
        sessionMap: FX_SESSION_MAP(
            'GBPUSD normally moves 80–120 pips/day (more than EURUSD) — size targets/SL in proportion to the real ATR',
        ),
        readingGuide: FX_READING_GUIDE(
            'GBPUSD loses when: DXY strong + risk-off (high-beta sterling) + BoE more dovish than the Fed + gilt market turmoil · wins when: DXY weak + risk-on + hawkish BoE + good UK data · EURUSD must confirm the same direction, otherwise it is a sterling-specific story',
            'Normal spread 0.5–1 pip, widening to 3–8 pips around rollover/UK news',
        ),
        brief: GBPUSD_BRIEF,
    },
    USDJPY: {
        modes: USDJPY_MODES,
        companionBrief_th:
            'Net effect of each companion on USDJPY in this mode: US10Y (main driver, up = supportive), DXY (supportive), VIX (fear = carry unwind, strong pressure), SPY/Nikkei (risk-on = carry continues, supportive), WTI (expensive oil = yen weak) — which support, which conflict, and which side the net favours + distance from the intervention zone',
        sessionMap: FX_SESSION_MAP(
            'USDJPY normally moves 70–120 pips (0.70–1.20 yen)/day — down legs from unwind/intervention run much faster than up legs',
        ),
        readingGuide: FX_READING_GUIDE(
            'USDJPY rises when: US yields up + DXY strong + risk-on (Nikkei/SPY up, VIX low) + BoJ easing · USDJPY falls when: yields down + risk-off (VIX spike = carry unwind) + hawkish BoJ + MoF intervention/warnings · BUY above 150 must always account for intervention risk',
            'Normal spread 0.1–0.5 pip, widening around rollover (high swap) and BoJ/intervention',
        ),
        brief: USDJPY_BRIEF,
    },
};
