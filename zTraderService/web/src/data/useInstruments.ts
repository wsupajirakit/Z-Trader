import { useQuery } from '@tanstack/react-query';
import type { InstrumentListItem } from '../api/types';
import { useTerminalPrefs } from '../shell/terminalStore';
import { instrumentsQuery, statusQuery } from './queries';

const EMPTY: InstrumentListItem[] = [];
export const FALLBACK_SYMBOLS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];

/** bot's active instrument (server), the known list, and the symbol the chart is showing */
export function useInstruments() {
  const { data: status } = useQuery(statusQuery);
  const { data: instruments } = useQuery(instrumentsQuery);
  const prefs = useTerminalPrefs();
  const list = instruments?.list ?? EMPTY;
  const active = status?.instrument.key ?? instruments?.active ?? 'XAUUSD';
  const symbols = list.length ? list.map((i) => i.key) : FALLBACK_SYMBOLS;
  const chartSymbol =
    prefs.chartSymbol && symbols.includes(prefs.chartSymbol)
      ? prefs.chartSymbol
      : active;
  const digitsFor = (symbol: string | null | undefined): number => {
    const hit = list.find((i) => i.key === symbol);
    if (hit) return hit.digits;
    if (symbol === 'USDJPY') return 3;
    if (symbol === 'XAUUSD' || !symbol) return 2;
    return 5;
  };
  const info = (symbol: string) => list.find((i) => i.key === symbol);
  return { active, list, symbols, chartSymbol, digitsFor, info };
}
