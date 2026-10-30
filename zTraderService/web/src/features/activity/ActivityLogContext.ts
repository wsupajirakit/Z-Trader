import { createContext, use, useSyncExternalStore } from 'react';
import type { ActivityLog, LogState } from './activityLog';

export const ActivityLogContext = createContext<ActivityLog | null>(null);

export function useActivityLog(): ActivityLog {
  const log = use(ActivityLogContext);
  if (!log)
    throw new Error('useActivityLog must be used inside <ActivityLogProvider>');
  return log;
}

export function useLogLines(): LogState {
  const log = useActivityLog();
  return useSyncExternalStore(log.subscribe, log.getSnapshot);
}
