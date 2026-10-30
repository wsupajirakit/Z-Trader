import type { GoldMode } from '../../api/types';

export const ARCHIVE_MODES: readonly GoldMode[] = [
  'scalp',
  'intraday',
  'swing',
  'position',
];
export const ARCHIVE_LIMITS = [20, 50, 100, 200] as const;
export const DEFAULT_ARCHIVE_LIMIT = 50;

export interface ArchiveSearch {
  mode?: GoldMode;
  limit?: number;
}

const isMode = (v: unknown): v is GoldMode =>
  typeof v === 'string' && (ARCHIVE_MODES as readonly string[]).includes(v);

/** `/archive?mode=&limit=` — unknown values are dropped */
export function validateArchiveSearch(
  search: Record<string, unknown>,
): ArchiveSearch {
  const limit = Number(search.limit);
  return {
    ...(isMode(search.mode) ? { mode: search.mode } : {}),
    ...((ARCHIVE_LIMITS as readonly number[]).includes(limit) ? { limit } : {}),
  };
}

/** `/archive/$mode/$file?full=1` — include the bar series */
export function validateArchiveFileSearch(search: Record<string, unknown>): {
  full?: boolean;
} {
  return search.full === true || search.full === 1 || search.full === '1'
    ? { full: true }
    : {};
}

/** "swing/20260804_091530_swing.json" → route params */
export function archiveParams(file: string): { mode: string; file: string } {
  const slash = file.indexOf('/');
  return slash < 0
    ? { mode: '', file }
    : { mode: file.slice(0, slash), file: file.slice(slash + 1) };
}
