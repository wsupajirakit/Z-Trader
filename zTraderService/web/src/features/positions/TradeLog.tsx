import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { dashboardApi } from '../../api/dashboard';
import type { LedgerTrade } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { ErrorState, LoadingState } from '../../components/States';
import { tradesQuery } from '../../data/queries';
import { fmtP } from '../../lib/format';
import { fmtRunning, fmtUsd } from '../../lib/pnl';
import { capsLabel } from '../../theme/theme';

const REASON: Record<string, { label: string; color: string; hint: string }> = {
  TP: { label: 'TP', color: 'terminal.up', hint: 'Closed at its take-profit' },
  SL: { label: 'SL', color: 'terminal.down', hint: 'Closed at its stop-loss' },
  MANUAL: {
    label: 'Manual',
    color: 'text.secondary',
    hint: 'Closed at market (dashboard, bot or broker app)',
  },
};

const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('en-GB', { hour12: false }) : '—';

/**
 * Every position of every instrument the account ever had since the ledger started (and the
 * history imported on its first run), newest first: running ones and closed ones with the broker's
 * own figures. Older pages load on demand; the first page refreshes every 30 s.
 */
export function TradeLog() {
  const q = useQuery(tradesQuery('all'));
  const [older, setOlder] = useState<LedgerTrade[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const next = cursor === undefined ? (q.data?.next_before ?? null) : cursor;

  const rows = useMemo(() => {
    const first = q.data?.trades ?? [];
    const seen = new Set(first.map((t) => t.positionId));
    return [...first, ...older.filter((t) => !seen.has(t.positionId))];
  }, [q.data?.trades, older]);

  const loadOlder = async () => {
    if (next == null) return;
    setLoading(true);
    try {
      const page = await dashboardApi.trades({ status: 'all', before: next });
      setOlder((o) => [...o, ...page.trades]);
      setCursor(page.next_before);
    } finally {
      setLoading(false);
    }
  };

  const columns = useMemo<Column<LedgerTrade>[]>(
    () => [
      {
        id: 'status',
        header: 'Status',
        cell: (t) => {
          if (t.status === 'OPEN')
            return (
              <Box
                component="span"
                sx={{ ...capsLabel, fontSize: 10, color: 'terminal.up' }}
              >
                ● Running
              </Box>
            );
          const r = t.closeReason ? REASON[t.closeReason] : null;
          return (
            <Tooltip title={r?.hint ?? 'Closed (read back from history)'}>
              <Box
                component="span"
                sx={{
                  ...capsLabel,
                  fontSize: 10,
                  color: r?.color ?? 'text.secondary',
                }}
              >
                Closed {r ? `· ${r.label}` : ''}
              </Box>
            </Tooltip>
          );
        },
        sortValue: (t) => t.status,
      },
      {
        id: 'symbol',
        header: 'Symbol',
        cell: (t) => <b>{t.symbol}</b>,
        sortValue: (t) => t.symbol,
      },
      {
        id: 'side',
        header: 'Side',
        cell: (t) => (
          <Box
            component="span"
            sx={{
              color: t.side === 'BUY' ? 'terminal.up' : 'terminal.down',
              fontWeight: 700,
            }}
          >
            {t.side}
          </Box>
        ),
      },
      {
        id: 'lots',
        header: 'Lots',
        align: 'right',
        cell: (t) => <span className="num">{t.lots.toFixed(2)}</span>,
      },
      {
        id: 'entry',
        header: 'Entry',
        align: 'right',
        cell: (t) => <span className="num">{fmtP(t.entry, t.digits)}</span>,
      },
      {
        id: 'close',
        header: 'Close',
        align: 'right',
        cell: (t) => (
          <span className="num">{fmtP(t.closePrice ?? null, t.digits)}</span>
        ),
      },
      {
        id: 'net',
        header: 'Net P&L',
        align: 'right',
        cell: (t) =>
          t.status === 'OPEN' && !t.closedLots ? (
            '—'
          ) : (
            <Tooltip
              title={`Gross ${fmtUsd(t.grossUsd)} · commission ${fmtUsd(t.commissionUsd)} · swap ${fmtUsd(t.swapUsd)}`}
            >
              <Box
                component="span"
                className="num"
                sx={{
                  color: t.netUsd >= 0 ? 'terminal.up' : 'terminal.down',
                  fontWeight: 700,
                }}
              >
                {fmtUsd(t.netUsd)}
              </Box>
            </Tooltip>
          ),
        sortValue: (t) => t.netUsd,
      },
      {
        id: 'held',
        header: 'Held',
        align: 'right',
        muted: true,
        cell: (t) =>
          fmtRunning(
            new Date(t.openedAt).getTime(),
            t.closedAt ? new Date(t.closedAt).getTime() : Date.now(),
          ),
      },
      {
        id: 'opened',
        header: 'Opened',
        muted: true,
        cell: (t) => when(t.openedAt),
        sortValue: (t) => t.openedAt,
      },
      {
        id: 'closed',
        header: 'Closed',
        muted: true,
        cell: (t) => when(t.closedAt),
      },
      {
        id: 'mode',
        header: 'Mode',
        muted: true,
        cell: (t) => t.mode ?? t.strategy ?? '—',
      },
    ],
    [],
  );

  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data.summary;
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <Box
        aria-label="Trade log summary"
        sx={{
          ...capsLabel,
          fontSize: 10,
          display: 'flex',
          gap: 2,
          px: 1.5,
          py: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <span>{s.open} running</span>
        <span>
          {s.closed} closed · {s.wins} won
          {s.closed ? ` (${Math.round((s.wins / s.closed) * 100)}%)` : ''}
        </span>
        <Box sx={{ flex: 1 }} />
        <span>
          Net{' '}
          <Box
            component="span"
            className="num"
            sx={{
              color: s.net_usd >= 0 ? 'terminal.up' : 'terminal.down',
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {fmtUsd(s.net_usd)}
          </Box>
        </span>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(t) => String(t.positionId)}
          caption="Trade log"
          empty="No trades yet"
        />
      </Box>
      {next != null ? (
        <Box sx={{ p: 1, textAlign: 'center' }}>
          <Button
            size="small"
            disabled={loading}
            onClick={() => void loadOlder()}
          >
            Load older trades
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
