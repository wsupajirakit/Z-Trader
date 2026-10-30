/** poll intervals and list sizes of the terminal */
export const POLL_MS = {
  activity: 5_000,
  status: 5_000,
  settings: 15_000,
  positions: 10_000,
  account: 30_000,
  archive: 30_000,
  aiModelsRetry: 15_000,
  actorState: 5_000,
  actorLogs: 4_000,
  news: 120_000,
} as const;

export const NEWS_LIMIT = 25;
export const HISTORY_DAYS = 30;
export const SIDEBAR_ARCHIVE_LIMIT = 8;
