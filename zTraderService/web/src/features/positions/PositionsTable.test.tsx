import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { LedgerResponse, Position } from '../../api/types';
import { baseRoutes, status } from '../../test/fixtures';
import { stubFetch } from '../../test/fetchStub';
import { renderApp } from '../../test/renderApp';

const RUNNING: Position = {
  state: 'RUNNING',
  positionId: 692085525,
  symbol: 'EURUSD',
  digits: 5,
  side: 'BUY',
  lots: 1.43,
  entry: 1.11969,
  stopLoss: 1.11805,
  takeProfit: 1.12279,
  openedAt: Date.now() - 12 * 60_000,
};
const WAITING: Position = {
  state: 'WAITING',
  orderType: 'LIMIT',
  positionId: 77,
  symbol: 'XAUUSD',
  digits: 2,
  side: 'BUY',
  lots: 0.1,
  entry: 3900,
  stopLoss: 3890,
  takeProfit: 3930,
  openedAt: Date.now(),
};

const LEDGER: LedgerResponse = {
  trades: [
    {
      positionId: 691427255,
      symbol: 'XAUUSD',
      side: 'SELL',
      lots: 0.02,
      digits: 2,
      entry: 3989.68,
      openedAt: '2026-10-30T09:28:59.437Z',
      status: 'CLOSED',
      closedAt: '2026-10-30T10:11:52.573Z',
      closePrice: 3984.64,
      closeReason: 'TP',
      closedLots: 0.02,
      grossUsd: 10.08,
      commissionUsd: -0.48,
      swapUsd: 0,
      netUsd: 9.6,
    },
  ],
  summary: { open: 1, closed: 1, wins: 1, net_usd: 9.6, gross_usd: 10.08 },
  next_before: null,
};

describe('positions and trade log', () => {
  it('a filled position says RUNNING with its live profit; a pending order says WAITING', async () => {
    stubFetch({
      ...baseRoutes(),
      'GET /api/dashboard/positions': [RUNNING, WAITING],
      'GET /api/dashboard/status': status({
        prices: {
          EURUSD: { bid: 1.12007, ask: 1.12009, age_sec: 0 },
          XAUUSD: { bid: 3910.2, ask: 3910.5, age_sec: 0 },
        },
      }),
    });
    renderApp('/trades', 'viewer');
    // the page table (the context rail shows a compact copy without the Now column)
    const tables = await screen.findAllByRole('table', {
      name: 'Open positions',
    });
    const table = tables.find((t) =>
      within(t).queryByRole('columnheader', { name: /Now/ }),
    )!;
    const rows = within(table).getAllByRole('row');
    const eur = rows.find((r) => within(r).queryByText('EURUSD'))!;
    expect(within(eur).getByText('● Running')).toBeInTheDocument();
    expect(within(eur).getByText('12m')).toBeInTheDocument();
    expect(within(eur).getByText('+$54.34')).toBeInTheDocument();
    expect(within(eur).getByText('+3.8')).toBeInTheDocument();
    const xau = rows.find((r) => within(r).queryByText('XAUUSD'))!;
    expect(within(xau).getByText('◌ Waiting')).toBeInTheDocument();
    expect(within(xau).getByText('105.0 to fill')).toBeInTheDocument();
    const summary = screen.getAllByLabelText('Open P&L')[0]!;
    expect(within(summary).getByText('1 running')).toBeInTheDocument();
    expect(within(summary).getByText('1 waiting')).toBeInTheDocument();
  });

  it('the trade log shows every closed trade with the broker net and why it closed', async () => {
    stubFetch({
      ...baseRoutes(),
      'GET /api/dashboard/trades': LEDGER,
    });
    renderApp('/trades', 'viewer');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('tab', { name: 'Trade log (all)' }),
    );
    const table = await screen.findByRole('table', { name: 'Trade log' });
    expect(within(table).getByText('Closed · TP')).toBeInTheDocument();
    expect(within(table).getByText('+$9.60')).toBeInTheDocument();
    const summary = screen.getByLabelText('Trade log summary');
    expect(
      within(summary).getByText('1 closed · 1 won (100%)'),
    ).toBeInTheDocument();
  });
});
