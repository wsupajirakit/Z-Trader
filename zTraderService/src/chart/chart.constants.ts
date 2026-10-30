import { INSTRUMENT_KEYS, type InstrumentKey } from '../gold/domain/instruments';
import type { TvInterval } from '../integrations/tradingview/tv-protocol';

export type ChartSymbol = InstrumentKey;
export const CHART_SYMBOLS: readonly ChartSymbol[] = INSTRUMENT_KEYS;

export type ChartTimeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
export const CHART_TIMEFRAMES: readonly ChartTimeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

export const TF_SECONDS: Record<ChartTimeframe, number> = {
    M1: 60,
    M5: 300,
    M15: 900,
    M30: 1800,
    H1: 3600,
    H4: 14_400,
    D1: 86_400,
};

export const TF_TV_INTERVAL: Record<ChartTimeframe, TvInterval> = {
    M1: '1',
    M5: '5',
    M15: '15',
    M30: '30',
    H1: '60',
    H4: '240',
    D1: '1D',
};

/** cTrader ProtoOATrendbarPeriod (proto/OpenApiModelMessages.proto) */
export const TF_CTRADER_PERIOD: Record<ChartTimeframe, number> = {
    M1: 1,
    M5: 5,
    M15: 7,
    M30: 8,
    H1: 9,
    H4: 10,
    D1: 12,
};

export const BARS_LIMIT_MIN = 50;
export const BARS_LIMIT_MAX = 2000;
export const BARS_LIMIT_DEFAULT = 500;

export const CTRADER_SOURCE = 'ctrader';

export interface ChartSource {
    id: string;
    label: string;
    kind: 'broker' | 'tradingview';
}

/**
 * TradingView exchanges per symbol. XAUUSD = z-service GOLD_SOURCES. The FX lists keep only the
 * exchanges that returned bars for that pair when probed live (2026-10-30); FXCM answered
 * "invalid symbol" for all three pairs and is left out.
 */
const TV_EXCHANGES: Record<ChartSymbol, Array<[exchange: string, label: string]>> = {
    XAUUSD: [
        ['OANDA', 'OANDA'],
        ['PEPPERSTONE', 'Pepperstone'],
        ['CAPITALCOM', 'Capital.com'],
        ['VANTAGE', 'Vantage'],
        ['ICMARKETS', 'IC Markets'],
        ['EIGHTCAP', 'Eightcap'],
        ['FOREXCOM', 'Forex.com'],
        ['BLACKBULL', 'BlackBull'],
    ],
    EURUSD: fxExchanges(),
    GBPUSD: fxExchanges(),
    USDJPY: fxExchanges(),
};

function fxExchanges(): Array<[string, string]> {
    return [
        ['OANDA', 'OANDA'],
        ['FX_IDC', 'ICE Data (FX_IDC)'],
        ['FOREXCOM', 'Forex.com'],
        ['PEPPERSTONE', 'Pepperstone'],
        ['ICMARKETS', 'IC Markets'],
        ['CAPITALCOM', 'Capital.com'],
        ['SAXO', 'Saxo'],
    ];
}

export function chartSources(symbol: ChartSymbol): ChartSource[] {
    return [
        { id: CTRADER_SOURCE, label: 'cTrader (account broker)', kind: 'broker' },
        ...TV_EXCHANGES[symbol].map(([ex, label]): ChartSource => ({ id: `tv:${ex}`, label, kind: 'tradingview' })),
    ];
}

/** every source id any symbol offers (first-pass validation; the per-symbol check is isSourceFor) */
export const ALL_SOURCE_IDS: readonly string[] = [
    ...new Set(CHART_SYMBOLS.flatMap((s) => chartSources(s).map((x) => x.id))),
];

export function isSourceFor(symbol: ChartSymbol, source: string): boolean {
    return chartSources(symbol).some((s) => s.id === source);
}

/** `tv:OANDA` + XAUUSD → `OANDA:XAUUSD`; null for a non-TradingView source */
export function tvFullSymbol(symbol: ChartSymbol, source: string): string | null {
    return source.startsWith('tv:') ? `${source.slice(3)}:${symbol}` : null;
}

/** `ctrader` stays lower-case; `tv:oanda` → `tv:OANDA` */
export function normalizeSource(v: unknown): unknown {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    if (s.toLowerCase() === CTRADER_SOURCE) return CTRADER_SOURCE;
    if (s.toLowerCase().startsWith('tv:')) return `tv:${s.slice(3).toUpperCase()}`;
    return s;
}
