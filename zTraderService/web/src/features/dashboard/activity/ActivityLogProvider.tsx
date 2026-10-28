import { useState, type ReactNode } from 'react';
import { ActivityLog } from './activityLog';
import { ActivityLogContext } from './ActivityLogContext';

/** One log per signed-in app shell; it resets when the shell unmounts (logout). */
export function ActivityLogProvider({ children }: { children: ReactNode }) {
  const [log] = useState(() => new ActivityLog());
  return <ActivityLogContext value={log}>{children}</ActivityLogContext>;
}
