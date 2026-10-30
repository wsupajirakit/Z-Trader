import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, session } from '../test/fixtures';
import { json, stubFetch } from '../test/fetchStub';
import { renderApp } from '../test/renderApp';

describe('session flow', () => {
  it('signed out → login page; a wrong password shows a generic message', async () => {
    stubFetch({
      ...baseRoutes(),
      'POST /api/auth/login': () =>
        json({ statusCode: 401, message: 'Unauthorized' }, 401),
    });
    renderApp('/bot', null);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'dev');
    await user.type(screen.getByLabelText('Password'), 'nope-nope-nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Wrong username or password',
    );
  });

  it('a lockout shows the minutes to wait', async () => {
    stubFetch({
      ...baseRoutes(),
      'POST /api/auth/login': () =>
        json(
          { statusCode: 429, message: 'Too Many Requests', retryAfterSec: 600 },
          429,
        ),
    });
    renderApp('/login', null);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'dev');
    await user.type(screen.getByLabelText('Password'), 'whatever-123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'try again in 10 minutes',
    );
  });

  it('a successful login opens the page it came from', async () => {
    const calls = stubFetch({
      ...baseRoutes(),
      'POST /api/auth/login': session('operator'),
    });
    const { router } = renderApp('/login?redirect=%2Fchart', null);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), ' Operator ');
    await user.type(screen.getByLabelText('Password'), 'secret-pass-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/chart');
    });
    expect(calls.find((c) => c.url === '/api/auth/login')?.body).toEqual({
      username: 'operator',
      password: 'secret-pass-1',
    });
  });

  it('a 401 from any poll sends the user to the login page', async () => {
    stubFetch({
      ...baseRoutes(),
      'GET /api/dashboard/status': () =>
        json({ statusCode: 401, message: 'Unauthorized' }, 401),
    });
    const { router } = renderApp('/bot', 'operator');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
  });
});
