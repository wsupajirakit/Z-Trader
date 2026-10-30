import { api, buildUrl } from './client';
import type {
  AccountSummary,
  ActorLogs,
  ActorState,
  ApplyProfileResult,
  ChartBarsResponse,
  ChartSourcesResponse,
  ChartTimeframe,
  RiskProfile,
  RiskProfileInput,
  RiskProfilesResponse,
} from './types';

export const accountApi = {
  summary: (signal?: AbortSignal) =>
    api.get<AccountSummary>('/api/dashboard/account', { signal }),
};

export const chartApi = {
  sources: (symbol: string, signal?: AbortSignal) =>
    api.get<ChartSourcesResponse>('/api/chart/sources', {
      query: { symbol },
      signal,
    }),
  bars: (
    p: { symbol: string; source: string; tf: ChartTimeframe; limit?: number },
    signal?: AbortSignal,
  ) =>
    api.get<ChartBarsResponse>('/api/chart/bars', { query: { ...p }, signal }),
  /** EventSource URL (same origin, the session cookie authorises it) */
  streamUrl: (p: { symbol: string; source: string; tf: ChartTimeframe }) =>
    buildUrl('/api/chart/stream', { ...p }),
};

const rp = '/api/risk-profiles';
export const riskProfilesApi = {
  list: (signal?: AbortSignal) => api.get<RiskProfilesResponse>(rp, { signal }),
  create: (body: RiskProfileInput) => api.post<RiskProfile>(rp, body),
  update: (id: string, body: Partial<RiskProfileInput>) =>
    api.patch<RiskProfile>(`${rp}/${encodeURIComponent(id)}`, body),
  remove: (id: string) =>
    api.delete<{ deleted: true }>(`${rp}/${encodeURIComponent(id)}`),
  apply: (id: string) =>
    api.post<ApplyProfileResult>(`${rp}/${encodeURIComponent(id)}/apply`),
};

export const actorApi = {
  state: (signal?: AbortSignal) =>
    api.get<ActorState>('/api/actor/state', { signal }),
  logs: (after: number, signal?: AbortSignal) =>
    api.get<ActorLogs>('/api/actor/logs', {
      query: { after, limit: 200 },
      signal,
    }),
  start: (body: { symbols: string[]; mode: string }) =>
    api.post<{ ok: true }>('/api/actor/start', body),
  stop: () => api.post<{ ok: true }>('/api/actor/stop'),
};
