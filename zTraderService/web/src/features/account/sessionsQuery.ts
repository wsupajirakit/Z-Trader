import { queryOptions } from '@tanstack/react-query';
import { authApi } from '../../api/auth';
import { qk } from '../../api/queryKeys';

export const sessionsQuery = queryOptions({
  queryKey: qk.auth.sessions,
  queryFn: ({ signal }) => authApi.sessions(signal),
});
