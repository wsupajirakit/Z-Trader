import { api } from './client';
import type {
  ActivityResponse,
  AiModelsResponse,
  AiResetResult,
  ArchiveEntry,
  ArchiveFile,
  AutomateRequest,
  BotSettings,
  BotStatus,
  ConfirmResult,
  DailyStopResetResult,
  GoldMode,
  HistoryResponse,
  InstrumentsResponse,
  ModesResponse,
  NewsItem,
  Position,
  RejectResult,
  RunRequest,
  RunResult,
  SettingsUpdate,
} from './types';

const base = '/api/dashboard';

/** Raw JSON URL of an archived round (opened in a new tab; the session cookie authorises it). */
export function archiveFileUrl(
  mode: string,
  file: string,
  full = false,
): string {
  const path = `${base}/archive/${encodeURIComponent(mode)}/${encodeURIComponent(file)}`;
  return full ? `${path}?full=1` : path;
}

export const dashboardApi = {
  // ---- reads (viewer) ----
  status: (signal?: AbortSignal) =>
    api.get<BotStatus>(`${base}/status`, { signal }),
  modes: (signal?: AbortSignal) =>
    api.get<ModesResponse>(`${base}/modes`, { signal }),
  instruments: (signal?: AbortSignal) =>
    api.get<InstrumentsResponse>(`${base}/instruments`, { signal }),
  activity: (after: number, signal?: AbortSignal) =>
    api.get<ActivityResponse>(`${base}/activity`, { query: { after }, signal }),
  settings: (signal?: AbortSignal) =>
    api.get<BotSettings>(`${base}/settings`, { signal }),
  news: (limit: number, signal?: AbortSignal) =>
    api.get<NewsItem[]>(`${base}/news`, { query: { limit }, signal }),
  archive: (
    params: { mode?: GoldMode | undefined; limit: number },
    signal?: AbortSignal,
  ) => api.get<ArchiveEntry[]>(`${base}/archive`, { query: params, signal }),
  archiveFile: (
    mode: string,
    file: string,
    full: boolean,
    signal?: AbortSignal,
  ) => api.get<ArchiveFile>(archiveFileUrl(mode, file, full), { signal }),
  positions: (signal?: AbortSignal) =>
    api.get<Position[]>(`${base}/positions`, { signal }),
  history: (days: number, signal?: AbortSignal) =>
    api.get<HistoryResponse>(`${base}/history`, { query: { days }, signal }),
  aiModels: (signal?: AbortSignal) =>
    api.get<AiModelsResponse>(`${base}/ai/models`, { signal }),

  // ---- actions (operator) ----
  setInstrument: (symbol: string) =>
    api.post<BotStatus>(`${base}/instrument`, { symbol }),
  saveSettings: (body: SettingsUpdate) =>
    api.post<BotSettings>(`${base}/settings`, body),
  resetDailyStop: () =>
    api.post<DailyStopResetResult>(`${base}/daily-stop/reset`),
  resetAiCalls: () => api.post<AiResetResult>(`${base}/ai/reset-calls`),
  automate: (body: AutomateRequest) =>
    api.post<BotStatus>(`${base}/automate`, body),
  run: (body: RunRequest) => api.post<RunResult>(`${base}/run`, body),
  analyze: (body: RunRequest) => api.post<RunResult>(`${base}/analyze`, body),
  confirm: (mode: GoldMode, id: string) =>
    api.post<ConfirmResult>(`${base}/confirm`, { mode, id }),
  reject: (mode: GoldMode, id: string, reason: string) =>
    api.post<RejectResult>(`${base}/reject`, { mode, id, reason }),
};
