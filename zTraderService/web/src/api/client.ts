/**
 * The only place that talks to `fetch`. Every request is same-origin with the session cookie;
 * every write carries the CSRF token; every failure becomes an `ApiError`.
 *
 * Session-level failures are reported to handlers the app installs at start-up
 * (`configureApiClient`), so the client never imports the router.
 */

export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

/** Paths that are writes but must not carry the CSRF token (docs/api.md: "except login"). */
const CSRF_EXEMPT = new Set(['/api/auth/login']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Run the global 401 / password-change handlers (default true). Auth endpoints turn this off:
   * a 401 from `login` is a wrong password and a 401 from `me` is handled by the route guard.
   */
  sessionHandlers?: boolean;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  /** Parsed response body (JSON when the server sent JSON, otherwise the raw text). */
  readonly body: unknown;
  /** `retryAfterSec` from a 429 login lockout. */
  readonly retryAfterSec: number | null;

  constructor(
    status: number,
    message: string,
    body: unknown,
    retryAfterSec: number | null = null,
  ) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isPasswordChangeRequired(): boolean {
    return this.status === 403 && this.message === PASSWORD_CHANGE_REQUIRED;
  }
}

/** Network failure (server down, offline): no HTTP status at all. */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

export interface ApiClientHandlers {
  onUnauthorized: () => void;
  onPasswordChangeRequired: () => void;
}

let handlers: ApiClientHandlers | null = null;
let csrfToken: string | null = null;

export function configureApiClient(next: ApiClientHandlers | null): void {
  handlers = next;
}

/** Set from `login` / `me`; fixed for the life of the session. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Human-readable message from a NestJS error body
 * (`{ statusCode, message: string | string[], error }`), falling back to `HTTP <status>`.
 */
export function errorMessageFrom(body: unknown, status: number): string {
  if (isRecord(body)) {
    const { message, error } = body;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message)) {
      const parts = message.filter((m): m is string => typeof m === 'string');
      if (parts.length) return parts.join(', ');
    }
    if (typeof error === 'string' && error) return error;
  }
  if (typeof body === 'string' && body.trim() && body.length <= 300)
    return body.trim();
  return `HTTP ${status}`;
}

function retryAfterFrom(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const v = body.retryAfterSec;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function buildUrl(
  path: string,
  query?: Record<string, QueryValue>,
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, query, signal, sessionHandlers = true } = options;
  const headers = new Headers({ Accept: 'application/json' });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (!SAFE_METHODS.has(method) && !CSRF_EXEMPT.has(path) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? null,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new NetworkError(e instanceof Error ? e.message : 'network error');
  }

  const data = await readBody(res);
  if (res.ok) return data as T;

  const error = new ApiError(
    res.status,
    errorMessageFrom(data, res.status),
    data,
    retryAfterFrom(data),
  );
  if (sessionHandlers && handlers) {
    if (error.isUnauthorized) handlers.onUnauthorized();
    else if (error.isPasswordChangeRequired)
      handlers.onPasswordChangeRequired();
  }
  throw error;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'body'>) =>
    request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, options),
};

/** Message for display from anything a query/mutation may throw. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
