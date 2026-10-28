import type { ReactNode } from 'react';
import type { Role } from '../../api/types';
import { useCan } from './session';

/**
 * Renders `children` only for users with at least `role`. The server enforces the same rule;
 * this only keeps the UI from offering actions that would come back 403.
 */
export function Can({
  role,
  children,
  fallback = null,
}: {
  role: Role;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(role) ? children : fallback;
}
