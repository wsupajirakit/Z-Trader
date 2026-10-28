import { api } from './client';
import type { CreateUserRequest, UpdateUserRequest, User } from './types';

const base = '/api/users';
const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const usersApi = {
  list: (signal?: AbortSignal) => api.get<User[]>(base, { signal }),
  create: (body: CreateUserRequest) => api.post<User>(base, body),
  update: (id: string, body: UpdateUserRequest) =>
    api.patch<User>(one(id), body),
  resetPassword: (id: string, password: string) =>
    api.post<undefined>(`${one(id)}/reset-password`, { password }),
};
