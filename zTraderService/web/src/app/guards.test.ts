import { createMemoryHistory, isRedirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { qk } from '../api/queryKeys';
import type { AuthPayload } from '../api/types';
import { json, stubFetch } from '../test/fetchStub';
import { session } from '../test/fixtures';
import { guardApp, guardGuest, guardRole } from './guards';
import { createQueryClient } from './queryClient';
import { createAppRouter } from './router';

const location = { href: '/admin/users?x=1', pathname: '/admin/users' };

async function redirectOf(p: Promise<unknown> | (() => unknown)) {
  try {
    if (typeof p === 'function') p();
    else await p;
  } catch (e) {
    if (isRedirect(e)) return e.options;
    throw e;
  }
  return null;
}

function clientWith(me: AuthPayload | null) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(qk.auth.me, me);
  return queryClient;
}

describe('guardApp', () => {
  it('sends a signed-out user to /login and remembers where they were going', async () => {
    stubFetch({ 'GET /api/auth/me': () => json({ statusCode: 401 }, 401) });
    const r = await redirectOf(
      guardApp({ context: { queryClient: createQueryClient() }, location }),
    );
    expect(r).toMatchObject({
      to: '/login',
      search: { redirect: '/admin/users?x=1' },
    });
  });

  it('sends a user with mustChangePassword to /change-password', async () => {
    const queryClient = clientWith(
      session('admin', { mustChangePassword: true }),
    );
    const r = await redirectOf(
      guardApp({ context: { queryClient }, location }),
    );
    expect(r).toMatchObject({ to: '/change-password' });
  });

  it('lets a signed-in user through and exposes the session', async () => {
    const me = session('viewer');
    await expect(
      guardApp({ context: { queryClient: clientWith(me) }, location }),
    ).resolves.toEqual({ session: me });
  });

  it('asks the server once when nothing is cached', async () => {
    const calls = stubFetch({ 'GET /api/auth/me': session('operator') });
    const queryClient = createQueryClient();
    await guardApp({ context: { queryClient }, location });
    await guardApp({ context: { queryClient }, location });
    expect(calls).toHaveLength(1);
  });
});

describe('guardRole', () => {
  it.each([
    ['viewer', 'admin', true],
    ['operator', 'admin', true],
    ['admin', 'admin', false],
    ['viewer', 'operator', true],
    ['operator', 'operator', false],
  ] as const)(
    '%s on a %s route → redirected: %s',
    async (role, required, redirected) => {
      const r = await redirectOf(() => {
        guardRole(required)({ context: { session: session(role) } });
      });
      expect(r === null ? false : r.to === '/').toBe(redirected);
    },
  );
});

describe('guardGuest', () => {
  it('sends a signed-in user away from /login', async () => {
    const r = await redirectOf(
      guardGuest({ context: { queryClient: clientWith(session('viewer')) } }),
    );
    expect(r).toMatchObject({ to: '/' });
  });
});

describe('route tree', () => {
  async function landOn(path: string, me: AuthPayload | null) {
    stubFetch({});
    const router = createAppRouter({
      queryClient: clientWith(me),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await router.load();
    return router.state.location.pathname;
  }

  it('signed out: any app page ends on /login', async () => {
    expect(await landOn('/', null)).toBe('/login');
    expect(await landOn('/admin/audit', null)).toBe('/login');
  });

  it('a viewer cannot reach the admin pages', async () => {
    expect(await landOn('/admin/users', session('viewer'))).toBe('/');
    expect(await landOn('/admin/audit', session('operator'))).toBe('/');
  });

  it('an admin can', async () => {
    expect(await landOn('/admin/users', session('admin'))).toBe('/admin/users');
    expect(await landOn('/admin', session('admin'))).toBe('/admin/users');
  });

  it('mustChangePassword is forced to /change-password from anywhere in the app', async () => {
    expect(
      await landOn(
        '/archive',
        session('operator', { mustChangePassword: true }),
      ),
    ).toBe('/change-password');
  });
});
