import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, status } from '../../test/fixtures';
import { stubFetch } from '../../test/fetchStub';
import { renderApp } from '../../test/renderApp';

const header = (name: string) => screen.findByRole('button', { name });
const posts = (calls: { method: string; url: string }[], url: string) =>
  calls.filter((c) => c.method === 'POST' && c.url === url);

describe('execution panel', () => {
  it('opens on the auto loop; the single round is folded away', async () => {
    stubFetch(baseRoutes());
    renderApp('/bot', 'operator');
    expect(await header('Auto loop')).toHaveAttribute('aria-expanded', 'true');
    expect(await header('Single round')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Run now' }),
    ).not.toBeInTheDocument();
  });

  it('switching sections asks first; cancel keeps the loop, confirm swaps them', async () => {
    stubFetch(baseRoutes());
    renderApp('/bot', 'operator');
    const user = userEvent.setup();
    await user.click(await header('Single round'));
    let dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Switch to single round'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await header('Auto loop')).toHaveAttribute('aria-expanded', 'true');

    await user.click(await header('Single round'));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Switch' }));
    await waitFor(async () => {
      expect(await header('Single round')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
    expect(await header('Auto loop')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start' }),
    ).not.toBeInTheDocument();
  });

  it('folding the open section needs no confirmation', async () => {
    stubFetch(baseRoutes());
    renderApp('/bot', 'operator');
    const user = userEvent.setup();
    await user.click(await header('Auto loop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await header('Auto loop')).toHaveAttribute('aria-expanded', 'false');
  });

  it('switching away from a running loop stops it first', async () => {
    const calls = stubFetch({
      ...baseRoutes(),
      'GET /api/dashboard/status': status({ enabled: true }),
      'POST /api/dashboard/automate': status({ enabled: false }),
    });
    renderApp('/bot', 'operator');
    const user = userEvent.setup();
    await user.click(await header('Single round'));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Stop the loop and switch to a single round'),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: 'Stop loop and switch' }),
    );
    await waitFor(() => {
      expect(posts(calls, '/api/dashboard/automate')).toHaveLength(1);
    });
    expect(posts(calls, '/api/dashboard/automate')[0]).toMatchObject({
      body: { enabled: false },
    });
    expect(await header('Single round')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('a second single round asks first and names the previous result', async () => {
    const calls = stubFetch({
      ...baseRoutes(),
      'POST /api/dashboard/run': { decision: null, outcome: 'NO_TRADE' },
    });
    renderApp('/bot', 'operator');
    const user = userEvent.setup();
    await user.click(await header('Single round'));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Switch',
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => {
      expect(posts(calls, '/api/dashboard/run')).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Run another round')).toBeInTheDocument();
    expect(within(dialog).getByText(/NO_TRADE/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Run again' }));
    await waitFor(() => {
      expect(posts(calls, '/api/dashboard/run')).toHaveLength(2);
    });
  });
});
