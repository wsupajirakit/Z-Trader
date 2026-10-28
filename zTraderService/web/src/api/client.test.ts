import { describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetchStub';
import {
  api,
  ApiError,
  buildUrl,
  configureApiClient,
  errorMessageFrom,
  NetworkError,
  setCsrfToken,
} from './client';

describe('CSRF header', () => {
  it('is sent on POST / PATCH / PUT / DELETE and never on GET', async () => {
    const calls = stubFetch({
      'GET /api/x': {},
      'POST /api/x': {},
      'PATCH /api/x': {},
      'PUT /api/x': {},
      'DELETE /api/x': {},
    });
    setCsrfToken('tok-1');
    await api.get('/api/x');
    await api.post('/api/x', { a: 1 });
    await api.patch('/api/x', { a: 1 });
    await api.put('/api/x', { a: 1 });
    await api.delete('/api/x');

    const header = calls.map((c) => [c.method, c.headers.get('X-CSRF-Token')]);
    expect(header).toEqual([
      ['GET', null],
      ['POST', 'tok-1'],
      ['PATCH', 'tok-1'],
      ['PUT', 'tok-1'],
      ['DELETE', 'tok-1'],
    ]);
  });

  it('is not sent on login, even with a token in memory', async () => {
    const calls = stubFetch({
      'POST /api/auth/login': { user: {}, csrfToken: 'new' },
    });
    setCsrfToken('stale');
    await api.post('/api/auth/login', { username: 'a', password: 'b' });
    expect(calls[0]?.headers.has('X-CSRF-Token')).toBe(false);
  });

  it('is omitted when there is no token yet', async () => {
    const calls = stubFetch({ 'POST /api/x': {} });
    await api.post('/api/x');
    expect(calls[0]?.headers.has('X-CSRF-Token')).toBe(false);
  });

  it('sends JSON with same-origin credentials', async () => {
    const calls = stubFetch({ 'POST /api/x': {} });
    await api.post('/api/x', { mode: 'swing' });
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.credentials).toBe('same-origin');
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(calls[0]?.body).toEqual({ mode: 'swing' });
  });
});

describe('session handlers', () => {
  it('calls onUnauthorized on 401 and still rejects with ApiError', async () => {
    stubFetch({
      'GET /api/x': () =>
        json({ statusCode: 401, message: 'Unauthorized' }, 401),
    });
    const onUnauthorized = vi.fn();
    const onPasswordChangeRequired = vi.fn();
    configureApiClient({ onUnauthorized, onPasswordChangeRequired });

    const err = await api.get('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onPasswordChangeRequired).not.toHaveBeenCalled();
  });

  it('skips the handlers when the caller opts out (login / me)', async () => {
    stubFetch({
      'POST /api/auth/login': () =>
        json({ statusCode: 401, message: 'x' }, 401),
    });
    const onUnauthorized = vi.fn();
    configureApiClient({ onUnauthorized, onPasswordChangeRequired: vi.fn() });
    await expect(
      api.post('/api/auth/login', {}, { sessionHandlers: false }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('routes 403 PASSWORD_CHANGE_REQUIRED to its own handler', async () => {
    stubFetch({
      'GET /api/x': () =>
        json({ statusCode: 403, message: 'PASSWORD_CHANGE_REQUIRED' }, 403),
      'GET /api/y': () =>
        json({ statusCode: 403, message: 'Forbidden resource' }, 403),
    });
    const onPasswordChangeRequired = vi.fn();
    configureApiClient({ onUnauthorized: vi.fn(), onPasswordChangeRequired });

    const e = (await api.get('/api/x').catch((x: unknown) => x)) as ApiError;
    expect(e.isPasswordChangeRequired).toBe(true);
    expect(onPasswordChangeRequired).toHaveBeenCalledOnce();

    await api.get('/api/y').catch(() => undefined);
    expect(onPasswordChangeRequired).toHaveBeenCalledOnce();
  });
});

describe('responses and errors', () => {
  it('returns undefined for 204', async () => {
    stubFetch({ 'POST /api/x': () => new Response(null, { status: 204 }) });
    await expect(api.post('/api/x')).resolves.toBeUndefined();
  });

  it('keeps retryAfterSec of a 429 lockout', async () => {
    stubFetch({
      'POST /api/auth/login': () =>
        json({ statusCode: 429, message: 'locked', retryAfterSec: 840 }, 429),
    });
    const e = (await api
      .post('/api/auth/login', {})
      .catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(429);
    expect(e.retryAfterSec).toBe(840);
    expect(e.message).toBe('locked');
  });

  it('wraps a dead network in NetworkError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    await expect(api.get('/api/x')).rejects.toBeInstanceOf(NetworkError);
  });

  it.each([
    [
      { statusCode: 400, message: 'mode ต้องเป็น scalp', error: 'Bad Request' },
      'mode ต้องเป็น scalp',
    ],
    [
      { statusCode: 400, message: ['a must be a number', 'b is required'] },
      'a must be a number, b is required',
    ],
    [{ statusCode: 400, error: 'Bad Request' }, 'Bad Request'],
    ['plain text failure', 'plain text failure'],
    [undefined, 'HTTP 500'],
    [{ unexpected: true }, 'HTTP 500'],
  ])('message from %j', (body, expected) => {
    expect(errorMessageFrom(body, 500)).toBe(expected);
  });
});

describe('buildUrl', () => {
  it('drops empty values and encodes the rest', () => {
    expect(
      buildUrl('/api/a', { after: 0, mode: undefined, q: 'x y', full: '' }),
    ).toBe('/api/a?after=0&q=x+y');
    expect(buildUrl('/api/a', {})).toBe('/api/a');
  });
});
