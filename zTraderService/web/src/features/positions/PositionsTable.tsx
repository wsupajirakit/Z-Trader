import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { InstrumentListItem, Position, Quote } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { ErrorState, LoadingState } from '../../components/States';
import {
  instrumentsQuery,
  positionsQuery,
  statusQuery,
} from '../../data/queries';
import { fmtP } from '../../lib/format';
import { fmtRunning, fmtUsd, livePnl, type Pnl } from '../../lib/pnl';
import { capsLabel } from '../../theme/theme';
import { useQuotes } from './useQuotes';

interface Row extends Position {
  quote: Quote | null;
  pnl: Pnl | null;
  inst: InstrumentListItem | undefined;
}

/** pips still to go before a WAITING order fills (buy orders fill on the ask, sell orders on the bid) */
function pipsToFill(r: Row): number | null {
  if (!r.quote || !r.inst) return null;
  const px = r.side === 'BUY' ? r.quote.ask : r.quote.bid;
  return Math.abs(px - r.entry) / r.inst.pip;
}

const signColor = (n: number) => (n >= 0 ? 'terminal.up' : 'terminal.down');

function StateCell({ r, now }: { r: Row; now: number }) {
  const running = r.state === 'RUNNING';
  return (
    <Tooltip
      title={
        running
          ? 'Filled: the position is open and running'
          : `${r.orderType ?? 'Pending'} order not filled yet`
      }
    >
      <Box
        component="span"
        sx={{
          ...capsLabel,
          fontSize: 10,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          color: running ? 'terminal.up' : 'warning.main',
          whiteSpace: 'nowrap',
        }}
      >
        {running ? '● Running' : '◌ Waiting'}
        <Box component="span" sx={{ color: 'text.secondary' }}>
          {running
            ? r.openedAt
              ? fmtRunning(r.openedAt, now)
              : ''
            : (r.orderType ?? '')}
        </Box>
      </Box>
    </Tooltip>
  );
}

/**
 * Open positions of every instrument and the pending orders behind them. RUNNING rows show the
 * live profit worked out from a light price stream (one connection, only while positions run);
 * WAITING rows show how far the price still is from filling them.
 */
export function PositionsTable({ compact = false }: { compact?: boolean }) {
  const q = useQuery(positionsQuery);
  const { data: status } = useQuery(statusQuery);
  const { data: instruments } = useQuery(instrumentsQuery);
  const positions = useMemo(() => q.data ?? [], [q.data]);
  const runningSymbols = useMemo(
    () => positions.filter((p) => p.state !== 'WAITING').map((p) => p.symbol),
    [positions],
  );
  const streamed = useQuotes(runningSymbols);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 10_000);
    return () => {
      clearInterval(t);
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const polled = status?.prices ?? {};
    return positions.map((p) => {
      const fromPoll = polled[p.symbol];
      const quote =
        streamed[p.symbol] ??
        (fromPoll ? { bid: fromPoll.bid, ask: fromPoll.ask, at: 0 } : null);
      const inst = instruments?.list.find((i) => i.key === p.symbol);
      const pnl = p.state === 'WAITING' ? null : livePnl(p, quote, inst);
      return { ...p, quote, pnl, inst };
    });
  }, [positions, status?.prices, streamed, instruments?.list]);

  const columns = useMemo<Column<Row>[]>(() => {
    const cols: Column<Row>[] = [
      {
        id: 'state',
        header: 'State',
        cell: (r) => <StateCell r={r} now={now} />,
        sortValue: (r) => r.state,
      },
      {
        id: 'symbol',
        header: 'Symbol',
        cell: (r) => <b>{r.symbol}</b>,
        sortValue: (r) => r.symbol,
      },
      {
        id: 'side',
        header: 'Side',
        cell: (r) => (
          <Box
            component="span"
            sx={{
              color: r.side === 'BUY' ? 'terminal.up' : 'terminal.down',
              fontWeight: 700,
            }}
          >
            {r.side}
          </Box>
        ),
        sortValue: (r) => r.side,
      },
      {
        id: 'lots',
        header: 'Lots',
        align: 'right',
        cell: (r) => <span className="num">{r.lots.toFixed(2)}</span>,
        sortValue: (r) => r.lots,
      },
    ];
    if (!compact) {
      cols.push(
        {
          id: 'entry',
          header: 'Entry',
          align: 'right',
          cell: (r) => <span className="num">{fmtP(r.entry, r.digits)}</span>,
          sortValue: (r) => r.entry,
        },
        {
          id: 'sl',
          header: 'SL',
          align: 'right',
          cell: (r) => (
            <span className="num">{fmtP(r.stopLoss, r.digits)}</span>
          ),
        },
        {
          id: 'tp',
          header: 'TP',
          align: 'right',
          cell: (r) => (
            <span className="num">{fmtP(r.takeProfit, r.digits)}</span>
          ),
        },
        {
          id: 'now',
          header: 'Now',
          align: 'right',
          cell: (r) => {
            const px =
              r.pnl?.mark ??
              (r.quote ? (r.side === 'BUY' ? r.quote.ask : r.quote.bid) : null);
            return <span className="num">{fmtP(px, r.digits)}</span>;
          },
        },
        {
          id: 'pips',
          header: 'Pips',
          align: 'right',
          cell: (r) => {
            if (r.state === 'WAITING') {
              const left = pipsToFill(r);
              return left == null ? (
                '—'
              ) : (
                <Box
                  component="span"
                  className="num"
                  sx={{ color: 'text.secondary' }}
                >
                  {left.toFixed(1)} to fill
                </Box>
              );
            }
            if (!r.pnl) return '—';
            return (
              <Box
                component="span"
                className="num"
                sx={{ color: signColor(r.pnl.pips) }}
              >
                {(r.pnl.pips >= 0 ? '+' : '') + r.pnl.pips.toFixed(1)}
              </Box>
            );
          },
          sortValue: (r) => r.pnl?.pips ?? 0,
        },
      );
    }
    cols.push({
      id: 'pnl',
      header: 'P&L',
      align: 'right',
      cell: (r) =>
        r.pnl ? (
          <Box
            component="span"
            className="num"
            sx={{ color: signColor(r.pnl.usd), fontWeight: 700 }}
          >
            {fmtUsd(r.pnl.usd)}
          </Box>
        ) : (
          '—'
        ),
      sortValue: (r) => r.pnl?.usd ?? 0,
    });
    if (!compact) {
      cols.push({
        id: 'opened',
        header: 'Opened',
        muted: true,
        cell: (r) =>
          r.openedAt
            ? new Date(r.openedAt).toLocaleString('en-GB', { hour12: false })
            : '—',
        sortValue: (r) => r.openedAt ?? 0,
      });
    }
    return cols;
  }, [compact, now]);

  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const running = rows.filter((r) => r.state === 'RUNNING');
  const waiting = rows.length - running.length;
  const priced = running.filter((r) => r.pnl);
  const total = priced.reduce((s, r) => s + (r.pnl?.usd ?? 0), 0);
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
      }}
    >
      {rows.length ? (
        <Box
          aria-label="Open P&L"
          sx={{
            ...capsLabel,
            fontSize: 10,
            display: 'flex',
            gap: 2,
            alignItems: 'center',
            px: 1.5,
            py: 0.75,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Box component="span" sx={{ color: 'terminal.up' }}>
            {running.length} running
          </Box>
          {waiting ? (
            <Box component="span" sx={{ color: 'warning.main' }}>
              {waiting} waiting
            </Box>
          ) : null}
          <Box sx={{ flex: 1 }} />
          {priced.length ? (
            <Tooltip title="Gross profit at the current bid/ask; commission and swap are booked at the close (Trade log)">
              <Box component="span">
                Open P&L{' '}
                <Box
                  component="span"
                  className="num"
                  sx={{
                    color: signColor(total),
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {fmtUsd(total)}
                </Box>
              </Box>
            </Tooltip>
          ) : null}
        </Box>
      ) : null}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(r) => `${r.state}-${r.positionId}`}
          caption="Open positions"
          empty="No open positions"
        />
      </Box>
    </Box>
  );
}
