import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, settings, status } from '../test/fixtures';
import { stubFetch } from '../test/fetchStub';
import { renderApp } from '../test/renderApp';

describe('role gating', () => {
  it('viewer: reads the bot page but gets no trading controls or admin menu', async () => {
    stubFetch(baseRoutes());
    renderApp('/bot', 'viewer');
    expect(await screen.findByText('Execution control')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Run now' }),
    ).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(nav).queryByRole('link', { name: 'Users' }),
    ).not.toBeInTheDocument();
  });

  it('admin sees the admin entries in the rail', async () => {
    stubFetch(baseRoutes());
    renderApp('/', 'admin');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(
      within(nav).getByRole('link', { name: 'Users' }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole('link', { name: 'Audit' }),
    ).toBeInTheDocument();
  });

  it('operator: Start asks for confirmation, then posts the selection with the CSRF token', async () => {
    const calls = stubFetch({
      ...baseRoutes(),
      'POST /api/dashboard/automate': status({ enabled: true }),
    });
    renderApp('/bot', 'operator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Start the loop')).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: 'Start loop' }),
    );
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url === '/api/dashboard/automate',
        ),
      ).toBe(true);
    });
    const post = calls.find((c) => c.url === '/api/dashboard/automate');
    expect(post?.headers.get('X-CSRF-Token')).toBe('csrf-test-token');
    expect(post?.body).toEqual({
      enabled: true,
      modes: ['swing'],
      instruments: ['XAUUSD'],
    });
  });

  it('a LIVE account needs the word LIVE typed before the loop starts', async () => {
    stubFetch({
      ...baseRoutes(),
      'GET /api/dashboard/status': status({ accountMode: 'LIVE' }),
      'GET /api/dashboard/settings': settings(),
    });
    renderApp('/bot', 'operator');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Start loop' });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type LIVE to confirm'),
      'LIVE',
    );
    expect(confirm).toBeEnabled();
  });
});
