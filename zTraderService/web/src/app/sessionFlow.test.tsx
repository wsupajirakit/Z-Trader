import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, stubFetch } from '../test/fetchStub';
import {
  instruments,
  modes,
  session,
  settings,
  status,
} from '../test/fixtures';
import { App } from './App';
import { createQueryClient } from './queryClient';
import { createAppRouter } from './router';
import { installSessionHandlers } from './sessionHandlers';

const dashboard = {
  'GET /api/dashboard/instruments': instruments,
  'GET /api/dashboard/modes': modes,
  'GET /api/dashboard/settings': settings(),
  'GET /api/dashboard/positions': [],
  'GET /api/dashboard/archive': [],
  'GET /api/dashboard/activity': { latest_id: 0, entries: [] },
  'GET /api/dashboard/ai/models': { current: 'gemini-3.5-flash', models: [] },
};

function start(path: string) {
  const queryClient = createQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  installSessionHandlers(router, queryClient);
  render(<App queryClient={queryClient} router={router} />);
  return router;
}

async function fillLogin(username: string, password: string) {
  await userEvent.type(await screen.findByLabelText('ชื่อผู้ใช้'), username);
  await userEvent.type(screen.getByLabelText('รหัสผ่าน'), password);
  await userEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));
}

describe('login', () => {
  it('shows a generic message on 401 and the lockout time on 429', async () => {
    let attempt = 0;
    stubFetch({
      'GET /api/auth/me': () => json({ statusCode: 401 }, 401),
      'POST /api/auth/login': () =>
        ++attempt === 1
          ? json({ statusCode: 401, message: 'Unauthorized' }, 401)
          : json(
              { statusCode: 429, message: 'locked', retryAfterSec: 600 },
              429,
            ),
    });
    start('/login');
    await fillLogin('alice', 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '❌ ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
    );
    await userEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'ลองใหม่ในอีก 10 นาที',
      );
    });
  });

  it('sends lower-cased username and lands on the forced change-password screen', async () => {
    const calls = stubFetch({
      'GET /api/auth/me': () => json({ statusCode: 401 }, 401),
      'POST /api/auth/login': session('operator', { mustChangePassword: true }),
    });
    const router = start('/login');
    await fillLogin('Operator', 'initial-password-1');
    await screen.findByText(/ต้องตั้งรหัสผ่านใหม่ก่อนเข้าใช้งาน/);
    expect(router.state.location.pathname).toBe('/change-password');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      username: 'operator',
      password: 'initial-password-1',
    });
  });

  it('returns to the page that asked for the login', async () => {
    let signedIn = false;
    stubFetch({
      ...dashboard,
      'GET /api/auth/me': () =>
        signedIn ? json(session('admin')) : json({}, 401),
      'POST /api/auth/login': () => {
        signedIn = true;
        return json(session('admin'));
      },
      'GET /api/dashboard/status': status(),
      'GET /api/users': [],
    });
    const router = start('/admin/users');
    await fillLogin('admin', 'a-long-password');
    await screen.findByText('ผู้ใช้ทั้งหมด');
    expect(router.state.location.pathname).toBe('/admin/users');
  });
});

describe('session loss', () => {
  it('a 401 from any poll sends the user to /login', async () => {
    stubFetch({
      ...dashboard,
      'GET /api/auth/me': session('viewer'),
      'GET /api/dashboard/status': () =>
        json({ statusCode: 401, message: 'Unauthorized' }, 401),
    });
    const router = start('/');
    await screen.findByText('🔒 zTrader Dashboard');
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ redirect: '/' });
  });

  it('a 403 PASSWORD_CHANGE_REQUIRED sends the user to change the password', async () => {
    let mustChange = false;
    stubFetch({
      ...dashboard,
      'GET /api/auth/me': () =>
        json(session('viewer', { mustChangePassword: mustChange })),
      'GET /api/dashboard/status': () => {
        mustChange = true;
        return json(
          { statusCode: 403, message: 'PASSWORD_CHANGE_REQUIRED' },
          403,
        );
      },
    });
    const router = start('/');
    await screen.findByText(/ต้องตั้งรหัสผ่านใหม่ก่อนเข้าใช้งาน/);
    expect(router.state.location.pathname).toBe('/change-password');
  });
});
