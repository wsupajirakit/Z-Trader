import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import { POLL_MS } from '../../data/polling';
import { ActivityLog } from './activityLog';
import { ActivityLogContext, useActivityLog } from './ActivityLogContext';

/** one log per signed-in shell; it resets when the shell unmounts (logout) */
export function ActivityLogProvider({ children }: { children: ReactNode }) {
  const [log] = useState(() => new ActivityLog());
  return (
    <ActivityLogContext value={log}>
      <ActivityPoller />
      {children}
    </ActivityLogContext>
  );
}

/** polls /activity?after=<cursor> every 5 s, also in background tabs */
function ActivityPoller() {
  const log = useActivityLog();
  // the cursor lives in the store and is read at fetch time; it is not a cache key
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
  return null;
}
