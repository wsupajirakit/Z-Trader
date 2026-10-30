import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { baseRoutes } from '../../test/fixtures';
import { stubFetch } from '../../test/fetchStub';
import { renderCard } from '../../test/renderWithProviders';
import { StrategyView } from './StrategyView';

describe('strategy (zTraderActor)', () => {
  it('operators get Start; the log and market feed render', async () => {
    // jsdom has no layout; give the virtualized log a size so it renders rows
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    stubFetch(baseRoutes());
    renderCard(<StrategyView />, 'operator');
    expect(
      await screen.findByRole('button', { name: 'Start' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('[Exec] 🔌 Connected to Market Data Gateway'),
    ).toBeInTheDocument();
    expect(screen.getByText('55.2')).toBeInTheDocument();
  });

  it('viewers get no controls', async () => {
    stubFetch(baseRoutes());
    renderCard(<StrategyView />, 'viewer');
    expect(await screen.findByText('○ Stopped')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start' }),
    ).not.toBeInTheDocument();
  });

  it('explains when the Actor is not connected', async () => {
    stubFetch({
      ...baseRoutes(),
      'GET /api/actor/state': {
        available: false,
        reason: 'ACTOR_URL is not configured',
      },
    });
    renderCard(<StrategyView />, 'viewer');
    expect(
      await screen.findByText(/ACTOR_URL is not configured/),
    ).toBeInTheDocument();
  });
});
