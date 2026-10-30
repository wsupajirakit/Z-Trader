import { useSyncExternalStore } from 'react';
import type { ChartTimeframe } from '../api/types';

export type WorkspaceId = 'trader' | 'ai' | 'risk' | 'ops';

export interface LayoutItemPref {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TerminalPrefs {
  railExpanded: boolean;
  contextRail: boolean;
  tickerTape: boolean;
  workspace: WorkspaceId;
  /** symbol on the chart; null = follow the bot's active instrument */
  chartSymbol: string | null;
  chartTf: ChartTimeframe;
  /** chosen chart data source per symbol */
  chartSource: Record<string, string>;
  /** saved Launchpad layouts per workspace */
  layouts: Partial<Record<WorkspaceId, LayoutItemPref[]>>;
}

const STORAGE_KEY = 'zt:terminal:v1';
const TIMEFRAMES: readonly ChartTimeframe[] = [
  'M1',
  'M5',
  'M15',
  'M30',
  'H1',
  'H4',
  'D1',
];
const WORKSPACES: readonly WorkspaceId[] = ['trader', 'ai', 'risk', 'ops'];

export const DEFAULT_PREFS: TerminalPrefs = {
  railExpanded: false,
  contextRail: true,
  tickerTape: true,
  workspace: 'trader',
  chartSymbol: null,
  chartTf: 'M15',
  chartSource: {},
  layouts: {},
};

function load(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<TerminalPrefs>;
    const ws = WORKSPACES.find((w) => w === p.workspace) ?? 'trader';
    const tf = TIMEFRAMES.find((t) => t === p.chartTf) ?? 'M15';
    return {
      ...DEFAULT_PREFS,
      ...p,
      workspace: ws,
      chartTf: tf,
      chartSource: typeof p.chartSource === 'object' ? p.chartSource : {},
      layouts: typeof p.layouts === 'object' ? p.layouts : {},
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let state: TerminalPrefs =
  typeof localStorage === 'undefined' ? DEFAULT_PREFS : load();
const listeners = new Set<() => void>();

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** UI preferences of the terminal (rail, workspace, chart symbol/source/timeframe, layouts), kept in localStorage */
export const terminalStore = {
  get: () => state,
  set(
    patch:
      Partial<TerminalPrefs> | ((s: TerminalPrefs) => Partial<TerminalPrefs>),
  ) {
    const next = {
      ...state,
      ...(typeof patch === 'function' ? patch(state) : patch),
    };
    state = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode / quota: keep in memory */
    }
    for (const l of listeners) l();
  },
  reset() {
    state = DEFAULT_PREFS;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    for (const l of listeners) l();
  },
};

export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore(subscribe, terminalStore.get, terminalStore.get);
}

export { TIMEFRAMES };
