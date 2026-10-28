import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { authApi } from '../../api/auth';
import { setCsrfToken } from '../../api/client';
import { qk } from '../../api/queryKeys';
import { clearUserData } from './session';

/** Sign out: the server revokes the session; the client forgets everything it cached. */
export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: authApi.logout,
    // Even if the request fails (session already gone) the user wants to be signed out here.
    onSettled: async () => {
      setCsrfToken(null);
      qc.setQueryData(qk.auth.me, null);
      await navigate({ to: '/login' });
      clearUserData(qc);
    },
  });
}
