import { api, ApiError } from './client';
import type {
  AuthPayload,
  ChangePasswordRequest,
  LoginRequest,
  SessionInfo,
} from './types';

const noSessionHandlers = { sessionHandlers: false } as const;

export const authApi = {
  /** `null` when there is no valid session (401). */
  async me(signal?: AbortSignal): Promise<AuthPayload | null> {
    try {
      return await api.get<AuthPayload>('/api/auth/me', {
        ...noSessionHandlers,
        signal,
      });
    } catch (e) {
      if (e instanceof ApiError && e.isUnauthorized) return null;
      throw e;
    }
  },
  login: (body: LoginRequest) =>
    api.post<AuthPayload>('/api/auth/login', body, noSessionHandlers),
  logout: () =>
    api.post<undefined>('/api/auth/logout', undefined, noSessionHandlers),
  changePassword: (body: ChangePasswordRequest) =>
    api.post<undefined>('/api/auth/change-password', body),
  sessions: (signal?: AbortSignal) =>
    api.get<SessionInfo[]>('/api/auth/sessions', { signal }),
  revokeSession: (id: string) =>
    api.delete<undefined>(`/api/auth/sessions/${encodeURIComponent(id)}`),
  revokeOtherSessions: () =>
    api.post<undefined>('/api/auth/sessions/revoke-others'),
};
