import { ApiError, describeError } from '../../api/client';

export function loginError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) {
      const min = e.retryAfterSec ? Math.ceil(e.retryAfterSec / 60) : 15;
      return `Too many failed attempts — try again in ${min} minute${min === 1 ? '' : 's'}`;
    }
    if (e.status === 401) return 'Wrong username or password';
  }
  return describeError(e) || 'Sign-in failed';
}
