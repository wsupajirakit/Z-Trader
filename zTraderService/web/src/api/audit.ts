import { api } from './client';
import type { AuditPage } from './types';

export const auditApi = {
  page: (
    params: { limit: number; before?: string | null },
    signal?: AbortSignal,
  ) =>
    api.get<AuditPage>('/api/audit', {
      query: { limit: params.limit, before: params.before ?? undefined },
      signal,
    }),
};
