import type { LayoutItemPref, WorkspaceId } from '../shell/terminalStore';

export const WORKSPACE_LABEL: Record<WorkspaceId, string> = {
  trader: 'Trader',
  ai: 'AI',
  risk: 'Risk',
  ops: 'Ops',
};

/** default Launchpad layouts per workspace (12 columns, 30 px rows) */
export const DEFAULT_LAYOUTS: Record<WorkspaceId, LayoutItemPref[]> = {
  trader: [
    { i: 'chart', x: 0, y: 0, w: 8, h: 13 },
    { i: 'execution', x: 8, y: 0, w: 4, h: 9 },
    { i: 'riskToday', x: 8, y: 9, w: 4, h: 4 },
    { i: 'modes', x: 0, y: 13, w: 8, h: 8 },
    { i: 'positions', x: 8, y: 13, w: 4, h: 8 },
    { i: 'activity', x: 0, y: 21, w: 12, h: 7 },
  ],
  ai: [
    { i: 'ai', x: 0, y: 0, w: 5, h: 18 },
    { i: 'modes', x: 5, y: 0, w: 7, h: 9 },
    { i: 'activity', x: 5, y: 9, w: 7, h: 9 },
    { i: 'chart', x: 0, y: 18, w: 12, h: 11 },
  ],
  risk: [
    { i: 'profiles', x: 0, y: 0, w: 8, h: 14 },
    { i: 'riskToday', x: 8, y: 0, w: 4, h: 5 },
    { i: 'positions', x: 8, y: 5, w: 4, h: 9 },
    { i: 'riskForm', x: 0, y: 14, w: 8, h: 8 },
    { i: 'history', x: 8, y: 14, w: 4, h: 8 },
  ],
  ops: [
    { i: 'execution', x: 0, y: 0, w: 4, h: 9 },
    { i: 'health', x: 4, y: 0, w: 4, h: 9 },
    { i: 'archive', x: 8, y: 0, w: 4, h: 9 },
    { i: 'activity', x: 0, y: 9, w: 8, h: 11 },
    { i: 'news', x: 8, y: 9, w: 4, h: 11 },
  ],
};
