import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { DialogProvider } from '../components/dialogs/DialogProvider';
import { AppThemeProvider } from '../theme/AppThemeProvider';
import type { AppRouter } from './router';

export function App({
  queryClient,
  router,
}: {
  queryClient: QueryClient;
  router: AppRouter;
}) {
  return (
    <AppThemeProvider>
      <QueryClientProvider client={queryClient}>
        <DialogProvider>
          <RouterProvider router={router} />
        </DialogProvider>
      </QueryClientProvider>
    </AppThemeProvider>
  );
}
