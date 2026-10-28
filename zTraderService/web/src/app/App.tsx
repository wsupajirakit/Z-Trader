import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { AppRouter } from './router';

export function App({
  queryClient,
  router,
}: {
  queryClient: QueryClient;
  router: AppRouter;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
