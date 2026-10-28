import {
  queryOptions,
  useQuery,
  type QueryClient,
} from '@tanstack/react-query';
import { authApi } from '../../api/auth';
import { setCsrfToken } from '../../api/client';
import { qk } from '../../api/queryKeys';
import type { AuthPayload, Role, User } from '../../api/types';
import { hasRole } from './roles';

/** Store the CSRF token that comes with every session payload. */
export function adoptSession(session: AuthPayload | null): AuthPayload | null {
  setCsrfToken(session?.csrfToken ?? null);
  return session;
}

/**
 * `GET /api/auth/me` — `null` when signed out. Fresh until something says otherwise
 * (login, logout, a 401, a password change); the server is the one that enforces.
 */
export const sessionQuery = queryOptions({
  queryKey: qk.auth.me,
  queryFn: async ({ signal }) => adoptSession(await authApi.me(signal)),
  staleTime: Infinity,
  retry: false,
});

/** Session for route guards: the cached one, or ask the server once. */
export function loadSession(
  queryClient: QueryClient,
): Promise<AuthPayload | null> {
  return queryClient.query({ ...sessionQuery, staleTime: 'static' });
}

export function useSession(): AuthPayload | null {
  return useQuery(sessionQuery).data ?? null;
}

export function useCurrentUser(): User | null {
  return useSession()?.user ?? null;
}

/** Whether the signed-in user may do what `role` may do. */
export function useCan(role: Role): boolean {
  return hasRole(useCurrentUser()?.role, role);
}

/** Drop everything cached for the previous user; keep only the (now empty) session entry. */
export function clearUserData(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (q) => q.queryKey[0] !== qk.auth.all[0],
  });
  queryClient.removeQueries({ queryKey: qk.auth.sessions });
}
