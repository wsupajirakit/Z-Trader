import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { qk } from '../api/queryKeys';
import type { Role } from '../api/types';
import { createQueryClient } from '../app/queryClient';
import { DialogProvider } from '../components/dialogs/DialogProvider';
import { ActivityLogProvider } from '../features/activity/ActivityLogProvider';
import { AppThemeProvider } from '../theme/AppThemeProvider';
import { session } from './fixtures';

/** a component with the providers it needs and a signed-in `role` */
export function renderCard(ui: ReactElement, role: Role = 'operator') {
  const queryClient = createQueryClient();
  queryClient.setQueryData(qk.auth.me, session(role));
  const view = render(
    <AppThemeProvider>
      <QueryClientProvider client={queryClient}>
        <DialogProvider>
          <ActivityLogProvider>{ui}</ActivityLogProvider>
        </DialogProvider>
      </QueryClientProvider>
    </AppThemeProvider>,
  );
  return { ...view, queryClient };
}
