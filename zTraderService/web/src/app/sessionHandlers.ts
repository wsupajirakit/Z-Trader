import type { QueryClient } from '@tanstack/react-query';
import { configureApiClient, setCsrfToken } from '../api/client';
import { qk } from '../api/queryKeys';
import { clearUserData } from '../features/auth/session';
import type { AppRouter } from './router';

/**
 * What happens when any API call reports that the session is gone or must change its password.
 * Several polls can fail at once; navigating to the same place twice is harmless.
 */
export function installSessionHandlers(
  router: AppRouter,
  queryClient: QueryClient,
): void {
  configureApiClient({
    onUnauthorized: () => {
      setCsrfToken(null);
      queryClient.setQueryData(qk.auth.me, null);
      const { pathname, href } = router.state.location;
      if (pathname === '/login') return;
      void router
        .navigate({ to: '/login', search: { redirect: href } })
        .then(() => {
          clearUserData(queryClient);
        });
    },
    onPasswordChangeRequired: () => {
      if (router.state.location.pathname === '/change-password') return;
      void queryClient
        .invalidateQueries({ queryKey: qk.auth.me })
        .then(() => router.navigate({ to: '/change-password' }));
    },
  });
}
