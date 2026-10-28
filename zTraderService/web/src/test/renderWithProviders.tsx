import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { qk } from '../api/queryKeys';
import type { Role } from '../api/types';
import { createQueryClient } from '../app/queryClient';
import { ActivityLogProvider } from '../features/dashboard/activity/ActivityLogProvider';
import { SystemLog } from '../features/dashboard/activity/SystemLog';
import { InfoProvider } from '../features/dashboard/info/InfoProvider';
import { session } from './fixtures';

/** A dashboard card with the providers it needs, the System Log, and a signed-in `role`. */
export function renderCard(ui: ReactElement, role: Role = 'operator') {
  const queryClient = createQueryClient();
  queryClient.setQueryData(qk.auth.me, session(role));
  const view = render(
    <QueryClientProvider client={queryClient}>
      <InfoProvider>
        <ActivityLogProvider>
          {ui}
          <SystemLog />
        </ActivityLogProvider>
      </InfoProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}
