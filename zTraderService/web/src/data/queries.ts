import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { dashboardApi } from '../api/dashboard';
import { qk } from '../api/queryKeys';
import {
  accountApi,
  actorApi,
  chartApi,
  riskProfilesApi,
} from '../api/terminal';
import type { ChartTimeframe, GoldMode } from '../api/types';
import {
  HISTORY_DAYS,
  NEWS_LIMIT,
  POLL_MS,
  SIDEBAR_ARCHIVE_LIMIT,
} from './polling';

export const statusQuery = queryOptions({
  queryKey: qk.dashboard.status,
  queryFn: ({ signal }) => dashboardApi.status(signal),
  refetchInterval: POLL_MS.status,
});

export const instrumentsQuery = queryOptions({
  queryKey: qk.dashboard.instruments,
  queryFn: ({ signal }) => dashboardApi.instruments(signal),
  staleTime: Infinity,
});

export const modesQuery = (instrument: string) =>
  queryOptions({
    queryKey: qk.dashboard.modes(instrument),
    queryFn: ({ signal }) => dashboardApi.modes(signal),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

export const settingsQuery = queryOptions({
  queryKey: qk.dashboard.settings,
  queryFn: ({ signal }) => dashboardApi.settings(signal),
  refetchInterval: POLL_MS.settings,
});

export const positionsQuery = queryOptions({
  queryKey: qk.dashboard.positionsAll,
  queryFn: ({ signal }) => dashboardApi.positions(signal),
  refetchInterval: POLL_MS.positions,
});

export const accountQuery = queryOptions({
  queryKey: qk.account,
  queryFn: ({ signal }) => accountApi.summary(signal),
  refetchInterval: POLL_MS.account,
});

export const aiModelsQuery = queryOptions({
  queryKey: qk.dashboard.aiModels,
  queryFn: ({ signal }) => dashboardApi.aiModels(signal),
  staleTime: Infinity,
  retry: false,
  refetchInterval: (query) =>
    query.state.status === 'error' || !query.state.data?.models.length
      ? POLL_MS.aiModelsRetry
      : false,
});

export const sidebarArchiveQuery = queryOptions({
  queryKey: qk.dashboard.archive({ limit: SIDEBAR_ARCHIVE_LIMIT }),
  queryFn: ({ signal }) =>
    dashboardApi.archive({ limit: SIDEBAR_ARCHIVE_LIMIT }, signal),
  refetchInterval: POLL_MS.archive,
});

export const archiveListQuery = (params: {
  mode?: GoldMode | undefined;
  limit: number;
}) =>
  queryOptions({
    queryKey: qk.dashboard.archive(params),
    queryFn: ({ signal }) => dashboardApi.archive(params, signal),
  });

export const archiveFileQuery = (mode: string, file: string, full: boolean) =>
  queryOptions({
    queryKey: qk.dashboard.archiveFile(mode, file, full),
    queryFn: ({ signal }) => dashboardApi.archiveFile(mode, file, full, signal),
    staleTime: Infinity,
  });

export const historyQuery = (instrument: string) =>
  queryOptions({
    queryKey: qk.dashboard.history(instrument, HISTORY_DAYS),
    queryFn: ({ signal }) => dashboardApi.history(HISTORY_DAYS, signal),
    retry: false,
  });

export const newsQuery = (instrument: string) =>
  queryOptions({
    queryKey: qk.dashboard.news(instrument, NEWS_LIMIT),
    queryFn: ({ signal }) => dashboardApi.news(NEWS_LIMIT, signal),
    refetchInterval: POLL_MS.news,
  });

export const riskProfilesQuery = queryOptions({
  queryKey: qk.riskProfiles,
  queryFn: ({ signal }) => riskProfilesApi.list(signal),
  refetchInterval: POLL_MS.settings,
});

export const chartSourcesQuery = (symbol: string) =>
  queryOptions({
    queryKey: qk.chart.sources(symbol),
    queryFn: ({ signal }) => chartApi.sources(symbol, signal),
    staleTime: Infinity,
  });

export const chartBarsQuery = (
  symbol: string,
  source: string,
  tf: ChartTimeframe,
) =>
  queryOptions({
    queryKey: qk.chart.bars(symbol, source, tf),
    queryFn: ({ signal }) =>
      chartApi.bars({ symbol, source, tf, limit: 500 }, signal),
    staleTime: 30_000,
    retry: 1,
  });

export const actorStateQuery = queryOptions({
  queryKey: qk.actor.state,
  queryFn: ({ signal }) => actorApi.state(signal),
  refetchInterval: POLL_MS.actorState,
});
