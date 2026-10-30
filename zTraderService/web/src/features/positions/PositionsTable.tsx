import Box from '@mui/material/Box';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Position } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { ErrorState, LoadingState } from '../../components/States';
import { positionsQuery, statusQuery } from '../../data/queries';
import { fmtP } from '../../lib/format';

/** open positions of every instrument (cTrader), with live bid for distance to SL/TP */
export function PositionsTable({ compact = false }: { compact?: boolean }) {
  const q = useQuery(positionsQuery);
  const { data: status } = useQuery(statusQuery);
  const prices = useMemo(() => status?.prices ?? {}, [status?.prices]);
  const columns = useMemo<Column<Position>[]>(() => {
    const cols: Column<Position>[] = [
      {
        id: 'symbol',
        header: 'Symbol',
        cell: (p) => <b>{p.symbol}</b>,
        sortValue: (p) => p.symbol,
      },
      {
        id: 'side',
        header: 'Side',
        cell: (p) => (
          <Box
            component="span"
            sx={{
              color: p.side === 'BUY' ? 'terminal.up' : 'terminal.down',
              fontWeight: 700,
            }}
          >
            {p.side}
          </Box>
        ),
        sortValue: (p) => p.side,
      },
      {
        id: 'lots',
        header: 'Lots',
        align: 'right',
        cell: (p) => <span className="num">{p.lots.toFixed(2)}</span>,
        sortValue: (p) => p.lots,
      },
      {
        id: 'entry',
        header: 'Entry',
        align: 'right',
        cell: (p) => <span className="num">{fmtP(p.entry, p.digits)}</span>,
        sortValue: (p) => p.entry,
      },
    ];
    if (!compact) {
      cols.push(
        {
          id: 'sl',
          header: 'SL',
          align: 'right',
          cell: (p) => (
            <span className="num">{fmtP(p.stopLoss, p.digits)}</span>
          ),
        },
        {
          id: 'tp',
          header: 'TP',
          align: 'right',
          cell: (p) => (
            <span className="num">{fmtP(p.takeProfit, p.digits)}</span>
          ),
        },
      );
    }
    cols.push({
      id: 'move',
      header: 'Move',
      align: 'right',
      cell: (p) => {
        const px = prices[p.symbol];
        if (!px) return '—';
        const mark = p.side === 'BUY' ? px.bid : px.ask;
        const diff = p.side === 'BUY' ? mark - p.entry : p.entry - mark;
        return (
          <Box
            component="span"
            className="num"
            sx={{ color: diff >= 0 ? 'terminal.up' : 'terminal.down' }}
          >
            {(diff >= 0 ? '+' : '') + diff.toFixed(p.digits)}
          </Box>
        );
      },
    });
    if (!compact) {
      cols.push({
        id: 'opened',
        header: 'Opened',
        muted: true,
        cell: (p) =>
          p.openedAt
            ? new Date(p.openedAt).toLocaleString('en-GB', { hour12: false })
            : '—',
        sortValue: (p) => p.openedAt ?? 0,
      });
    }
    return cols;
  }, [compact, prices]);

  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <DataTable
      columns={columns}
      data={q.data}
      getRowId={(p) => String(p.positionId)}
      caption="Open positions"
      empty="No open positions"
    />
  );
}
