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
        horizon: 'In and out within 1–4 hours',
        tfRoles: '5m = execution TF (entry/SL) · 15m = context TF (direction/liquidity pools)',
        slGuide:
            'SL above/below the sweep point + spread buffer · or 0.5–0.8 × ATR14(5m) · never place exactly on a $50/$100 round number (swept most often)',
        playbook: [
            'Main setup A — Liquidity Sweep: price spikes clearly through a high/low or a round number ($xx50/$xx00) then snaps straight back into the range (sweep+displacement) → enter on the retest of the freshly broken level/FVG · target = the opposite-side pool · SL just beyond the sweep',
            'Main setup B — Asian range Break-Retest: at London open (14:00 BKK / 03:00 ET) price breaks the Asian range then pulls back to retest the range edge → enter in the breakout direction · stats: breakouts run on average 1.5–2× the Asian range width',
            'Money-making windows for this mode: London open 14:00-16:00 BKK and London-NY overlap 19:00-23:00 BKK (08:00-12:00 ET = highest-volume period of the day) — outside these windows (especially from NY close to Asia open) spreads are wide and signals unreliable = NO-TRADE by default',
            'Round numbers: gold systematically stalls/bounces/reverses at $50 and $100 levels — do not set the first TP beyond the next round number · for entries near a round number wait for the sweep first, do not front-run',
            'Realistic target per trade: $2–4 (20–40 pips) · news at 19:30 BKK (08:30 ET: NFP/CPI/jobless) = NO-TRADE ±30 minutes — news minutes are the most volatile timestamps of the week, spreads widen and slippage is heavy',
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
        horizon: 'Hold for hours to overnight (1–4 h or more)',
        tfRoles: '15m/30m = entry timing · 1h = direction TF',
        slGuide: 'SL 0.8–1.2 × ATR14(1h) or below/above the opposite edge of the Asian range · avoid round numbers',
        playbook: [
            'The core game of this mode is the 3-session cycle: Asia (06:00-14:00 BKK) builds the day range → London (14:00 BKK) breaks or rejects the range → continuation into NY (19:30 BKK) — standard target 1.5–2× the Asian range width',
            'Setup A — London break: break of the Asian high/low + a 15m/30m bar closing outside the range + retest that holds → BUY STOP/SELL STOP in the breakout direction or enter on the retest',
            'Setup B — London reject (fade): spike through the range then close back inside (fake breakout) → trade against it toward the opposite range edge — half the size of Setup A',
            'NY 19:30 BKK (08:30 ET) data is the intraday accelerator/reversal point — only hold through it with trades already in profit buffer; new trades wait 15-30 minutes after the news · FOMC day = no opening before 01:00 BKK (14:00 ET)',
            'Always check intraday direction against DXY/US10Y 1h: gold moves inverse to DXY (corr −0.5..−0.8) — if gold rises together with DXY rising = a weak leg, do not chase',
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
        horizon: 'Hold for several days to several weeks',
        tfRoles: '1h = entry timing · 4h = structure · 1d = primary direction TF',
        slGuide:
            'SL always below/above the swing low/high of the pullback used for entry (not a floating ATR, not a round number) · check the width ≈ 1.0–1.5 × ATR14(1d)',
        playbook: [
            'Core structure (trend-pullback): use 4H EMA50 vs EMA200 as the trend filter (50>200 = BUY side only) → wait for a pullback into one of the zones: 4H EMA20/50 · Fib 38.2/50/61.8 of the latest leg (deep zone 61.8–78.6 = OTE, best RR) · or old resistance turned support',
            "Enter only with confirmation: reversal bar (hammer/engulfing) on 1H-4H · RSI divergence · or a break of the pullback's minor trendline — no confirmation = a BUY LIMIT at the zone is allowed but at half size only",
            'Macro overlay before deciding direction: the old gold–REAL YIELD relationship (corr ≈ −0.82) broke down in 2022 (down to ~3-7% — central banks became the main buyers; in 2025 yields hit their highest since 2007 yet gold rose 65%) → use US10Y as a secondary, asymmetric factor: yields down = strong support for gold, but yields up = pressures gold less than it used to; never use it alone to veto the BUY side · DXY still works, corr −0.5..−0.8 · two institutional signals: ① DXY makes a new high but gold does not make a new low = bullish divergence (someone is absorbing) ② yields+DXY up but gold sideways = hidden accumulation',
            'Magnet levels: weekly open · prev week high/low · $100 round numbers — use as TP targets and expected reaction points',
            'Use XAGUSD to confirm the complex: silver leading higher = a healthy metals uptrend · gold rising alone with silver not following = a fragile leg',
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
        horizon: 'Hold for several weeks to several months',
        tfRoles: '1d = accumulation timing · 1w = primary trend TF',
        slGuide:
            'SL below weekly structure (1w swing low · ≈1.0–1.5 × ATR14(1w)) · scale in over 3-4 entries, never all at once',
        playbook: [
            'Primary direction comes mainly from 1W structure (weekly close above/below EMA20W) · the real-yield regime is only a secondary factor — the old −0.82 corr broke down in 2022 because central-bank accumulation (~225 tonnes/quarter) replaced ETF flow as the price driver: rising yields are not a reason to sell, but falling yields are still a reason to buy (asymmetric)',
            'Scale in on deep daily pullbacks (Fib 50-61.8 of the 1W leg) — first entry on touching the zone, next entries when a daily/weekly reversal bar confirms',
            'Use GDX as a lead indicator: miners stronger than gold = institutions betting on further upside · miners persistently weaker than gold = the uptrend is running out of steam',
            'In this mode a single event does not change direction — what changes it is the whole Fed policy cycle: cycle turning points (first cut/first hike) are the point to review the thesis every time',
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
    'Summarize the effect of each companion on gold in this mode: DXY (inverse), US10Y (inverse via real yield), VIX (fear = supports gold), USDJPY (intervention/ safe-haven flow), SPY (risk appetite), WTI (inflation), BTC (competing hedge), XAGUSD (metals-complex confirmation), GDX (miners lead/lag) — which ones support, which conflict, and which side the net result favors';

export const ANALYSIS_REQUEST = (
    spec: GoldModeSpec,
    mode: string,
    companionBrief: string = ANALYSIS_COMPANION_BRIEF_XAU,
    assetName_th = 'gold',
): Array<[string, string]> => [
    ['Mode', `${mode} — ${spec.horizon} · TF: ${spec.tfRoles}`],
    [
        'Output 1 — Bias',
        'Direction per TF (up/down/sideways) + reasoning from price structure, EMA stack, RSI, CMF, support/resistance, latest bar',
    ],
    [
        'Output 2 — Order',
        "Pick exactly one, clearly: BUY LIMIT @price / BUY STOP @price / SELL LIMIT @price / SELL STOP @price — or NO-TRADE (should not trade this round) with reasons · never give an ambiguous 'could buy or sell' answer",
    ],
    [
        'Output 3 — Levels',
        `Entry zone + SL + TP1 + TP2, all as numbers · ${spec.slGuide} · minimum R:R ${spec.rrMin}:1 — below this answer NO-TRADE · the entry must reference at least one setup in the ENTRY_PLAYBOOK below; if the current price does not meet any setup = NO-TRADE, wait`,
    ],
    [
        'Output 4 — Invalidation',
        'Conditions that kill the setup (price/event) — once touched, cancel pending orders immediately',
    ],
    ['Output 5 — Companions', companionBrief],
    [
        'Output 6 — News',
        `News in LATEST_FINANCIAL_NEWS affecting ${assetName_th} + timing of upcoming major news (Fed/CPI/jobs) — if a major event falls within the horizon, reduce size or NO-TRADE`,
    ],
    [
        'Output 7 — Size & Confidence',
        'Recommended size (full/half/quarter) based on ATR, and confidence 0-10, with a one-line reason',
    ],
    [
        'Output 8 — Summary',
        'Plain-language summary in 3-5 lines: trade or not and why, plan A (the main order) and plan B (if price moves the other way)',
    ],
];

export const SESSION_MAP: Array<[string, string]> = [
    [
        'Asia',
        '06:00–14:00 BKK (19:00–03:00 ET) — quiet, builds the day range (Asian range) used as the framework for London',
    ],
    ['London open', '14:00 BKK (03:00 ET) — first real move of the day, often breaks/rejects the Asian range'],
    [
        'London–NY overlap',
        '19:00–23:00 BKK (08:00–12:00 ET) — highest volume+volatility of the day · main money-making window for scalp/intraday',
    ],
    [
        'US data',
        '19:30 BKK (08:30 ET) = NFP (first Friday of the month)/CPI/jobless — the most volatile timestamp of the week · FOMC 01:00 BKK (14:00 ET)',
    ],
    ['Dead zone', 'After NY close 04:00-05:00 BKK + before Asia wakes up — wide spreads, SL easily swept, no trading'],
    ['Daily range', 'Gold normally moves $20–50+/day — size targets/SL in proportion to the real range, not hope'],
];

export const READING_GUIDE = (priceSource: string): Array<[string, string]> => [
    [
        'Order Semantics',
        'BUY LIMIT = buy below the current price (wait for a dip) · BUY STOP = buy above the current price (wait for a breakout) · SELL LIMIT = sell above the current price (wait for a bounce) · SELL STOP = sell below the current price (wait for a breakdown)',
    ],
    [
        'Volume Caveat',
        'Volume in every file = tick volume of CFD/FX — CMF/OBV/RVOL are for relative comparison only, do not read them as institutional money like in equities',
    ],
    [
        'Multi-TF Rule',
        'Higher TF gives direction, lower TF gives timing — if they conflict, reduce size or NO-TRADE · never use signals from unclosed bars (Is_Closed_Bar=False) as confirmation',
    ],
    [
        'Correlation Playbook',
        'Gold loses when: DXY strong + real yield up + full risk-on · gold wins when: weak dollar + yields down + fear (VIX up) or accelerating inflation (WTI up sharply) · yen intervention (selling USD) usually supports gold short term',
    ],
    [
        'Session',
        'Metals market open ~23 h/day, closed 17:00-18:00 ET and weekends · liquidity is thinnest from NY close to Asia open — wide spreads, beware of SL getting swept',
    ],
    [
        'Spread Note',
        `XAUUSD prices come from ${priceSource} — the same feed as the account that executes real orders; always set levels from this data set, never mix in prices from other sources · companions come from Yahoo Finance (may differ by source, use for direction only)`,
    ],
];
