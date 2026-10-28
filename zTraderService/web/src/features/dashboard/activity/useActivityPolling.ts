import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../../../api/dashboard';
import { qk } from '../../../api/queryKeys';
import { POLL_MS } from '../polling';
import { useActivityLog } from './ActivityLogContext';

/**
 * Polls `/activity?after=<cursor>` every 5 s, also in a background tab like the original
 * `setInterval`. Query drives the schedule; the ActivityLog store holds the lines.
 */
export function useActivityPolling(): void {
  const log = useActivityLog();
  // The cursor lives in the store and is read at fetch time; it is not a cache key —
  // every poll must land in the same query so the schedule is not reset.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  useQuery({
    queryKey: qk.dashboard.activity,
    queryFn: async ({ signal }) => {
      const res = await dashboardApi.activity(log.cursor, signal);
      log.ingest(res);
      return res.latest_id;
    },
    refetchInterval: POLL_MS.activity,
    refetchIntervalInBackground: true,
    retry: false,
  });
}
