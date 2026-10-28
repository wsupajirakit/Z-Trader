import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type { GoldMode } from '../../api/types';
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

/** Mode list belongs to the active instrument; a new key refetches it after a switch. */
export const modesQuery = (instrument: string) =>
  queryOptions({
    queryKey: qk.dashboard.modes(instrument),
    queryFn: ({ signal }) => dashboardApi.modes(signal),
    staleTime: Infinity,
    // keep the previous instrument's modes on screen until the new list arrives
    placeholderData: keepPreviousData,
  });

export const settingsQuery = queryOptions({
  queryKey: qk.dashboard.settings,
  queryFn: ({ signal }) => dashboardApi.settings(signal),
  refetchInterval: POLL_MS.settings,
});

/** Positions of every instrument; keyed by the active one so a switch refreshes it at once. */
export const positionsQuery = (instrument: string) =>
  queryOptions({
    queryKey: qk.dashboard.positions(instrument),
    queryFn: ({ signal }) => dashboardApi.positions(signal),
    refetchInterval: POLL_MS.positions,
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

/** History and news load each time their tab is opened (staleTime 0 + mount). */
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
  });
