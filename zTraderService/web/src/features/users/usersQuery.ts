import { queryOptions } from '@tanstack/react-query';
import { qk } from '../../api/queryKeys';
import { usersApi } from '../../api/users';

export const usersQuery = queryOptions({
  queryKey: qk.users.all,
  queryFn: ({ signal }) => usersApi.list(signal),
});
