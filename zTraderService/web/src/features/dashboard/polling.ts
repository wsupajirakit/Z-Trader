/** Poll intervals, identical to the original `boot()` timers. */
export const POLL_MS = {
  /** activity feed (System Log) */
  activity: 5_000,
  /** bot status: badges, live stats, pending decisions, loop state */
  status: 5_000,
  /**
   * AI quota / settings change slower than prices — 15 s is enough. Kept as its own request
   * instead of folding the fields into /status: the same value in two places would drift.
   */
  settings: 15_000,
  positions: 10_000,
  /** sidebar "Archive ล่าสุด" */
  archive: 30_000,
  /**
   * The model list must heal itself: the original retried on every settings refresh while the
   * dropdown was empty, so a single failed ListModels did not leave it empty for good.
   */
  aiModelsRetry: 15_000,
} as const;

export const NEWS_LIMIT = 25;
export const HISTORY_DAYS = 30;
export const SIDEBAR_ARCHIVE_LIMIT = 8;
