import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { baseRoutes } from '../../test/fixtures';
import { stubFetch } from '../../test/fetchStub';
import { renderCard } from '../../test/renderWithProviders';
import { ChartView } from './ChartView';

vi.mock('lightweight-charts', () => {
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
  };
  return {
    createChart: vi.fn(() => ({
      addSeries: vi.fn(() => series),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
      remove: vi.fn(),
    })),
    CandlestickSeries: {},
    HistogramSeries: {},
    ColorType: { Solid: 'solid' },
    CrosshairMode: { Normal: 0 },
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
  };
});

class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  url: string;
  onerror: (() => void) | null = null;
  static last: FakeEventSource | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener() {
    return undefined;
  }
  close() {
    return undefined;
  }
}

describe('chart', () => {
  it('loads bars for the default source and reloads + re-subscribes when the source changes', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const calls = stubFetch(baseRoutes());
    renderCard(<ChartView />, 'viewer');
    expect(await screen.findByTestId('price-chart')).toBeInTheDocument();
    expect(
      calls.some(
        (c) =>
          c.url.startsWith('/api/chart/bars') &&
          c.url.includes('source=ctrader') &&
          c.url.includes('tf=M15'),
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(FakeEventSource.last?.url).toContain('source=ctrader');
    });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole('combobox', { name: 'Chart data source' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'TradingView · OANDA' }),
    );
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('source=tv%3AOANDA'))).toBe(true);
    });
    await waitFor(() => {
      expect(FakeEventSource.last?.url).toContain('source=tv%3AOANDA');
    });
  });
});
