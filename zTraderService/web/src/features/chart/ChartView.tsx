import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChartBar, ChartTimeframe } from '../../api/types';
import { ErrorState, LoadingState } from '../../components/States';
import { StatusDot } from '../../components/StatusDot';
import {
  chartBarsQuery,
  chartSourcesQuery,
  positionsQuery,
  statusQuery,
} from '../../data/queries';
import { useInstruments } from '../../data/useInstruments';
import { fmtP } from '../../lib/format';
import {
  terminalStore,
  TIMEFRAMES,
  useTerminalPrefs,
} from '../../shell/terminalStore';
import { useResolvedScheme } from '../../theme/useResolvedScheme';
import {
  PriceChart,
  type PriceChartHandle,
  type PriceLevel,
} from './PriceChart';
import { useChartStream } from './useChartStream';

/**
 * Live chart: pick the instrument, the data source (cTrader account broker or a TradingView
 * exchange) and the timeframe; history comes from /api/chart/bars, updates over SSE. Open
 * positions and pending decisions of the instrument are drawn as price lines.
 */
export function ChartView({ toolbar = true }: { toolbar?: boolean }) {
  const prefs = useTerminalPrefs();
  const { chartSymbol: symbol, symbols, digitsFor, active } = useInstruments();
  const scheme = useResolvedScheme();
  const tf = prefs.chartTf;
  const sources = useQuery(chartSourcesQuery(symbol));
  const list = sources.data?.sources ?? [];
  const stored = prefs.chartSource[symbol];
  const source =
    stored && list.some((s) => s.id === stored)
      ? stored
      : (list[0]?.id ?? 'ctrader');
  const bars = useQuery({
    ...chartBarsQuery(symbol, source, tf),
    enabled: sources.isSuccess,
  });
  const { data: positions } = useQuery(positionsQuery);
  const { data: status } = useQuery(statusQuery);
  const chartRef = useRef<PriceChartHandle>(null);
  const resetKey = `${symbol}|${source}|${tf}`;
  const [last, setLast] = useState<{ key: string; bar: ChartBar } | null>(null);
  const digits = digitsFor(symbol);

  const onBar = useCallback(
    (bar: ChartBar) => {
      chartRef.current?.update(bar);
      setLast({ key: resetKey, bar });
    },
    [resetKey],
  );
  const stream = useChartStream(
    bars.isSuccess ? { symbol, source, tf } : null,
    onBar,
  );

  const levels = useMemo<PriceLevel[]>(() => {
    const out: PriceLevel[] = [];
    for (const p of positions ?? []) {
      if (p.symbol !== symbol) continue;
      out.push({
        id: `e${p.positionId}`,
        price: p.entry,
        title: `${p.side} ${p.lots.toFixed(2)}`,
        kind: 'entry',
      });
      if (p.stopLoss)
        out.push({
          id: `s${p.positionId}`,
          price: p.stopLoss,
          title: 'SL',
          kind: 'sl',
        });
      if (p.takeProfit)
        out.push({
          id: `t${p.positionId}`,
          price: p.takeProfit,
          title: 'TP',
          kind: 'tp',
        });
    }
    if (status && symbol === active) {
      for (const [mode, pend] of Object.entries(status.pending)) {
        const d = status.state[mode]?.lastDecision;
        if (d?.entry == null) continue;
        out.push({
          id: `p${pend.id}`,
          price: d.entry,
          title: `pending ${mode}`,
          kind: 'pending',
        });
        if (d.sl != null)
          out.push({
            id: `ps${pend.id}`,
            price: d.sl,
            title: `${mode} SL`,
            kind: 'sl',
          });
        if (d.tp1 != null)
          out.push({
            id: `pt${pend.id}`,
            price: d.tp1,
            title: `${mode} TP1`,
            kind: 'tp',
          });
      }
    }
    return out;
  }, [positions, status, symbol, active]);

  const lastBar =
    (last?.key === resetKey ? last.bar : null) ??
    bars.data?.bars.at(-1) ??
    null;
  const first = bars.data?.bars.at(-2);
  const change = lastBar && first ? lastBar.close - first.close : null;
  const streamDot =
    stream.state === 'live'
      ? 'ok'
      : stream.state === 'error' || stream.state === 'closed'
        ? 'error'
        : 'warn';

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      {toolbar ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
            flexWrap: 'wrap',
          }}
        >
          <Select
            size="small"
            value={symbol}
            inputProps={{ 'aria-label': 'Chart instrument' }}
            onChange={(e) => {
              terminalStore.set({ chartSymbol: e.target.value });
            }}
            sx={{ minWidth: 110, fontWeight: 700 }}
          >
            {symbols.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </Select>
          {/* chart only — the bot always analyses the cTrader feed */}
          <Select
            size="small"
            value={list.some((s) => s.id === source) ? source : ''}
            displayEmpty
            inputProps={{ 'aria-label': 'Chart data source' }}
            onChange={(e) => {
              const v = e.target.value;
              terminalStore.set((p) => ({
                chartSource: { ...p.chartSource, [symbol]: v },
              }));
            }}
            sx={{ minWidth: 190 }}
          >
            {list.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.kind === 'tradingview'
                  ? `TradingView · ${s.label}`
                  : s.label}
              </MenuItem>
            ))}
          </Select>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={tf}
            aria-label="Timeframe"
            onChange={(_e, v: ChartTimeframe | null) => {
              if (v) terminalStore.set({ chartTf: v });
            }}
          >
            {TIMEFRAMES.map((t) => (
              <ToggleButton key={t} value={t} aria-label={t}>
                {t}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Box sx={{ flex: 1 }} />
          {lastBar ? (
            <Box
              className="num"
              sx={{ display: 'flex', gap: 2, fontSize: 11.5 }}
            >
              <span>O {fmtP(lastBar.open, digits)}</span>
              <span>H {fmtP(lastBar.high, digits)}</span>
              <span>L {fmtP(lastBar.low, digits)}</span>
              <Box component="span" sx={{ fontWeight: 700 }}>
                C {fmtP(lastBar.close, digits)}
              </Box>
              {change != null ? (
                <Box
                  component="span"
                  sx={{ color: change >= 0 ? 'terminal.up' : 'terminal.down' }}
                >
                  {(change >= 0 ? '+' : '') + change.toFixed(digits)}
                </Box>
              ) : null}
            </Box>
          ) : null}
          <Tooltip title={stream.message ?? `Live stream: ${stream.state}`}>
            <Box
              sx={{
                display: 'flex',
                gap: 1,
                alignItems: 'center',
                fontSize: 10,
                textTransform: 'uppercase',
                color: 'text.secondary',
              }}
            >
              <StatusDot
                state={bars.isSuccess ? streamDot : 'off'}
                pulse={stream.state === 'live'}
              />
              {bars.isSuccess ? stream.state : 'idle'}
            </Box>
          </Tooltip>
        </Box>
      ) : null}
      <Box sx={{ flex: 1, minHeight: 200, position: 'relative' }}>
        {sources.isError ? (
          <ErrorState
            error={sources.error}
            onRetry={() => void sources.refetch()}
          />
        ) : null}
        {bars.isError ? (
          <ErrorState error={bars.error} onRetry={() => void bars.refetch()} />
        ) : null}
        {bars.isPending && !sources.isError ? (
          <LoadingState label={`Loading ${symbol} ${tf}…`} />
        ) : null}
        {bars.isSuccess ? (
          <PriceChart
            ref={chartRef}
            bars={bars.data.bars}
            digits={digits}
            scheme={scheme}
            levels={levels}
            resetKey={resetKey}
          />
        ) : null}
      </Box>
    </Box>
  );
}
