import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { qk } from '../api/queryKeys';
import type { Role } from '../api/types';
import { App } from '../app/App';
import { createQueryClient } from '../app/queryClient';
import { createAppRouter } from '../app/router';
import { installSessionHandlers } from '../app/sessionHandlers';
import { setCsrfToken } from '../api/client';
import { session } from './fixtures';

/** the whole app at `path`, signed in as `role` (or signed out with null) */
export function renderApp(path: string, role: Role | null = 'operator') {
  const queryClient = createQueryClient();
  if (role) {
    const s = session(role);
    queryClient.setQueryData(qk.auth.me, s);
    setCsrfToken(s.csrfToken);
  } else {
    queryClient.setQueryData(qk.auth.me, null);
  }
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  installSessionHandlers(router, queryClient);
  const view = render(<App queryClient={queryClient} router={router} />);
  return { ...view, router, queryClient };
}
