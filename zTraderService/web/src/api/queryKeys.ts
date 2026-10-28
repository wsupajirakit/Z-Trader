/**
 * Every query key in the app. Hierarchical, so `invalidateQueries({ queryKey: qk.dashboard.all })`
 * refreshes the whole dashboard and `qk.auth.all` everything tied to the session.
 */
export const qk = {
  auth: {
    all: ['auth'] as const,
    me: ['auth', 'me'] as const,
    sessions: ['auth', 'sessions'] as const,
  },
  users: {
    all: ['users'] as const,
  },
  audit: {
    all: ['audit'] as const,
    list: (limit: number) => ['audit', 'list', limit] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
    status: ['dashboard', 'status'] as const,
    instruments: ['dashboard', 'instruments'] as const,
    /** Modes/news/history depend on the active instrument, so it is part of their key. */
    modes: (instrument: string) => ['dashboard', 'modes', instrument] as const,
    news: (instrument: string, limit: number) =>
      ['dashboard', 'news', instrument, limit] as const,
    history: (instrument: string, days: number) =>
      ['dashboard', 'history', instrument, days] as const,
    positionsAll: ['dashboard', 'positions'] as const,
    positions: (instrument: string) =>
      ['dashboard', 'positions', instrument] as const,
    settings: ['dashboard', 'settings'] as const,
    aiModels: ['dashboard', 'ai-models'] as const,
    activity: ['dashboard', 'activity'] as const,
    archive: (params: { mode?: string | undefined; limit: number }) =>
      ['dashboard', 'archive', params] as const,
    archiveFile: (mode: string, file: string, full: boolean) =>
      ['dashboard', 'archive-file', mode, file, full] as const,
  },
};
