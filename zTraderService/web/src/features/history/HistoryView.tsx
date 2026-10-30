import Box from '@mui/material/Box';
import { LineChart } from '@mui/x-charts/LineChart';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { TradeAgg, TradeRow } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { RouterMuiLink } from '../../components/RouterMuiLink';
import { archiveParams } from '../archive/archiveSearch';
import { Stat } from '../../components/Panel';
import { ErrorState, LoadingState } from '../../components/States';
import { historyQuery } from '../../data/queries';
import { useInstruments } from '../../data/useInstruments';
import { closedShort, fmtP, money } from '../../lib/format';
import { capsLabel } from '../../theme/theme';

function AggRow({ label, a }: { label: string; a: TradeAgg | undefined }) {
  if (!a) return null;
  return (
    <Stat
      label={label}
      value={`${a.trades} · ${(a.winrate * (a.winrate <= 1 ? 100 : 1)).toFixed(0)}% · ${money(a.net_usd)}`}
      tone={a.net_usd >= 0 ? 'up' : 'down'}
    />
  );
}

/** closed trades of the bot's instrument (30 days): summary, cumulative P&L chart, table */
export function HistoryView({ chart = true }: { chart?: boolean }) {
  const { active, digitsFor } = useInstruments();
  const q = useQuery(historyQuery(active));
  const rows = useMemo(
    () =>
      [...(q.data?.trades ?? [])].sort((a, b) =>
        a.closed_utc.localeCompare(b.closed_utc),
      ),
    [q.data],
  );
  const curve = useMemo(
    () =>
      rows.reduce<{ x: Date; y: number }[]>((acc, t) => {
        acc.push({
          x: new Date(t.closed_utc),
          y: (acc.at(-1)?.y ?? 0) + t.net_usd,
        });
        return acc;
      }, []),
    [rows],
  );
  const columns = useMemo<Column<TradeRow>[]>(
    () => [
      {
        id: 'closed',
        header: 'Closed (UTC)',
        cell: (t) => <span className="num">{closedShort(t.closed_utc)}</span>,
        sortValue: (t) => t.closed_utc,
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
        sortValue: (t) => t.side,
      },
      {
        id: 'lots',
        header: 'Lots',
        align: 'right',
        cell: (t) => <span className="num">{t.lots.toFixed(2)}</span>,
        sortValue: (t) => t.lots,
      },
      {
        id: 'entry',
        header: 'Entry',
        align: 'right',
        cell: (t) => (
          <span className="num">
            {fmtP(t.entry, digitsFor(t.instrument ?? active))}
          </span>
        ),
      },
      {
        id: 'close',
        header: 'Close',
        align: 'right',
        cell: (t) => (
          <span className="num">
            {fmtP(t.close, digitsFor(t.instrument ?? active))}
          </span>
        ),
      },
      {
        id: 'net',
        header: 'Net',
        align: 'right',
        cell: (t) => (
          <Box
            component="span"
            className="num"
            sx={{
              color: t.net_usd >= 0 ? 'terminal.up' : 'terminal.down',
              fontWeight: 600,
            }}
          >
            {money(t.net_usd)}
          </Box>
        ),
        sortValue: (t) => t.net_usd,
      },
      {
        id: 'exit',
        header: 'Exit',
        cell: (t) => t.exit_kind,
        sortValue: (t) => t.exit_kind,
      },
      {
        id: 'strategy',
        header: 'Strategy',
        muted: true,
        cell: (t) => t.playbook ?? t.strategy,
        sortValue: (t) => t.strategy,
      },
      {
        id: 'profile',
        header: 'Profile',
        muted: true,
        cell: (t) => t.risk_profile ?? '—',
        sortValue: (t) => t.risk_profile ?? '',
      },
      {
        id: 'config',
        header: 'Config',
        muted: true,
        cell: (t) =>
          t.archive_file ? (
            <RouterMuiLink
              to="/archive/$mode/$file"
              params={archiveParams(t.archive_file.replace(/^archive\//, ''))}
              className="num"
            >
              {t.config_hash ?? 'round'}
            </RouterMuiLink>
          ) : (
            <span className="num">{t.config_hash ?? '—'}</span>
          ),
        sortValue: (t) => t.config_hash ?? '',
      },
      {
        id: 'hold',
        header: 'Hold',
        align: 'right',
        muted: true,
        cell: (t) => (t.hold_min == null ? '—' : `${t.hold_min}m`),
        sortValue: (t) => t.hold_min ?? 0,
      },
    ],
    [active, digitsFor],
  );

  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        height: '100%',
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: chart ? 'minmax(220px, 300px) 1fr' : '1fr',
          gap: 2,
        }}
      >
        <Box>
          <Box
            sx={{ ...capsLabel, fontSize: 10, color: 'text.secondary', mb: 1 }}
          >
            {d.instrument} · last {d.days} days · {d.account_mode}
          </Box>
          <AggRow label="All trades" a={d.summary} />
          <AggRow label="With H4 trend" a={d.with_h4_trend} />
          <AggRow label="Against H4 trend" a={d.against_h4_trend} />
          <AggRow label="BUY" a={d.by_side.BUY} />
          <AggRow label="SELL" a={d.by_side.SELL} />
        </Box>
        {chart && curve.length > 1 ? (
          <Box sx={{ height: 180 }}>
            <LineChart
              height={180}
              margin={{ left: 8, right: 16, top: 12, bottom: 8 }}
              xAxis={[
                {
                  data: curve.map((c) => c.x),
                  scaleType: 'time',
                  valueFormatter: (v: Date) =>
                    v.toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                    }),
                },
              ]}
              yAxis={[{ width: 56 }]}
              series={[
                {
                  data: curve.map((c) => c.y),
                  label: 'Cumulative net USD',
                  showMark: false,
                  area: true,
                  color: (curve.at(-1)?.y ?? 0) >= 0 ? '#00c176' : '#ff4d4f',
                },
              ]}
              grid={{ horizontal: true }}
              hideLegend
            />
          </Box>
        ) : null}
      </Box>
      <Box sx={{ flex: 1, minHeight: 160 }}>
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(t) => `${t.position_id}-${t.closed_utc}`}
          caption="Closed trades"
          empty="No closed trades in this period"
          initialSort={[{ id: 'closed', desc: true }]}
        />
      </Box>
    </Box>
  );
}
