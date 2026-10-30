import PlayArrow from '@mui/icons-material/PlayArrow';
import Stop from '@mui/icons-material/Stop';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState } from 'react';
import { qk } from '../../api/queryKeys';
import { actorApi } from '../../api/terminal';
import type { ActorLogEntry } from '../../api/types';
import { useDialogs } from '../../components/dialogs/context';
import { DataTable } from '../../components/DataTable';
import { Panel } from '../../components/Panel';
import { EmptyState, LoadingState } from '../../components/States';
import { POLL_MS } from '../../data/polling';
import { actorStateQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { useInstruments } from '../../data/useInstruments';
import { fmtP, timeOf } from '../../lib/format';
import { capsLabel } from '../../theme/theme';
import { useCan } from '../auth/session';
import { FONT_MONO } from '../../theme/tokens';

const MAX_LINES = 500;

/** Actor log lines, polled with a cursor (ids restart when the Actor restarts) */
function useActorLogs(enabled: boolean): ActorLogEntry[] {
  const cursor = useRef(0);
  const [lines, setLines] = useState<ActorLogEntry[]>([]);
  // the cursor is read at fetch time; it is not a cache key
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  useQuery({
    queryKey: qk.actor.logs,
    enabled,
    refetchInterval: POLL_MS.actorLogs,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await actorApi.logs(cursor.current, signal);
      if ('available' in res) return 0;
      if (res.latestId < cursor.current) {
        cursor.current = 0;
        setLines([]);
        return res.latestId;
      }
      if (res.entries.length) {
        cursor.current = res.entries.at(-1)?.id ?? cursor.current;
        setLines((prev) => [...prev, ...res.entries].slice(-MAX_LINES));
      }
      return res.latestId;
    },
  });
  return lines;
}

function ActorLog({ lines }: { lines: ActorLogEntry[] }) {
  const parent = useRef<HTMLDivElement>(null);
  // TanStack Virtual returns fresh functions each render; the compiler skips this component
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 20,
    // first paint (and jsdom) before the scroll element is measured
    initialRect: { width: 800, height: 400 },
    overscan: 10,
  });
  useEffect(() => {
    if (lines.length) v.scrollToIndex(lines.length - 1, { align: 'end' });
  }, [lines.length, v]);
  if (!lines.length) return <EmptyState>No log lines yet</EmptyState>;
  return (
    <Box
      ref={parent}
      role="log"
      aria-label="Strategy log"
      sx={{
        height: '100%',
        overflow: 'auto',
        fontFamily: FONT_MONO,
        fontSize: 11,
      }}
    >
      <Box sx={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((item) => {
          const l = lines[item.index];
          if (!l) return null;
          return (
            <Box
              key={l.id}
              data-index={item.index}
              ref={v.measureElement}
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${item.start}px)`,
                display: 'flex',
                gap: 1.5,
                px: 2,
                py: 0.25,
                color:
                  l.type === 'error'
                    ? 'terminal.down'
                    : l.channel === 'order'
                      ? 'terminal.up'
                      : 'text.primary',
              }}
            >
              <Box
                component="span"
                sx={{ color: 'text.secondary', flexShrink: 0 }}
              >
                {timeOf(l.ts)}
              </Box>
              <span>{l.message}</span>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** the legacy Sonic/Scalper loop running in zTraderActor, controlled through the service bridge */
export function StrategyView() {
  const q = useQuery(actorStateQuery);
  const canOperate = useCan('operator');
  const dialogs = useDialogs();
  const { symbols: known, digitsFor } = useInstruments();
  const available = q.data?.available === true;
  const lines = useActorLogs(available);
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const start = useAction({
    fn: (v: { symbols: string[]; mode: string }) => actorApi.start(v),
    invalidate: [qk.actor.state],
    success: (_r, v) =>
      `Strategy started · ${v.symbols.join(', ')} · ${v.mode}`,
    failure: (m) => `Could not start the strategy: ${m}`,
    tag: 'strategy',
  });
  const stop = useAction({
    fn: () => actorApi.stop(),
    invalidate: [qk.actor.state],
    success: () => 'Strategy stopped',
    failure: (m) => `Could not stop the strategy: ${m}`,
    tag: 'strategy',
  });

  if (q.isPending) return <LoadingState />;
  if (!q.data?.available) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info" variant="outlined">
          The strategy service (zTraderActor) is not connected:{' '}
          {q.data && 'reason' in q.data ? q.data.reason : 'no answer'}. Run
          zTraderActor and set ACTOR_URL on the service.
        </Alert>
      </Box>
    );
  }
  const st = q.data;
  const shownSymbols = st.isRunning || !symbols ? st.symbols : symbols;
  const shownMode = st.isRunning || !mode ? st.mode : mode;
  const pick = Array.from(new Set([...known, ...st.symbols]));

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: '360px 1fr' },
        gridTemplateRows: { lg: 'auto 1fr' },
        gap: 2,
        p: 2,
        height: '100%',
        minHeight: 0,
      }}
    >
      <Panel title="Strategy control" scroll={false}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Box
            sx={{
              ...capsLabel,
              fontSize: 11,
              color: st.isRunning ? 'terminal.up' : 'text.secondary',
              flex: 1,
            }}
          >
            {st.isRunning ? `● Running · ${st.mode}` : '○ Stopped'}
          </Box>
          {canOperate ? (
            st.isRunning ? (
              <Button
                variant="contained"
                color="error"
                startIcon={<Stop />}
                disabled={stop.isPending}
                onClick={() => {
                  stop.mutate(undefined);
                }}
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="contained"
                color="success"
                startIcon={<PlayArrow />}
                disabled={start.isPending || !shownSymbols.length}
                onClick={async () => {
                  const ok = await dialogs.confirm({
                    title: 'Start the strategy loop',
                    message: `The legacy ${shownMode} strategy will trade ${shownSymbols.join(', ')} automatically (max ${st.maxPositions} positions).`,
                    confirmLabel: 'Start',
                  });
                  if (ok)
                    start.mutate({ symbols: shownSymbols, mode: shownMode });
                }}
              >
                Start
              </Button>
            )
          ) : null}
        </Box>
        <TextField
          select
          fullWidth
          label="Strategy mode"
          value={shownMode}
          disabled={!canOperate || st.isRunning}
          onChange={(e) => {
            setMode(e.target.value);
          }}
          sx={{ mb: 2 }}
        >
          {st.modes.map((m) => (
            <MenuItem key={m} value={m}>
              {m}
            </MenuItem>
          ))}
        </TextField>
        <Box
          sx={{ ...capsLabel, fontSize: 10, color: 'text.secondary', mb: 0.5 }}
        >
          Symbols
        </Box>
        {pick.map((s) => (
          <FormControlLabel
            key={s}
            label={<span className="num">{s}</span>}
            control={
              <Checkbox
                checked={shownSymbols.includes(s)}
                disabled={!canOperate || st.isRunning}
                onChange={(e) => {
                  setSymbols(
                    e.target.checked
                      ? [...shownSymbols, s]
                      : shownSymbols.filter((x) => x !== s),
                  );
                }}
              />
            }
          />
        ))}
      </Panel>
      <Panel title="Market (strategy feed)" dense>
        <DataTable
          columns={[
            { id: 'symbol', header: 'Symbol', cell: (r) => <b>{r.symbol}</b> },
            {
              id: 'price',
              header: 'Price',
              align: 'right',
              cell: (r) => (
                <span className="num">
                  {fmtP(r.price, digitsFor(r.symbol))}
                </span>
              ),
            },
            {
              id: 'rsi',
              header: 'RSI',
              align: 'right',
              cell: (r) => (
                <span className="num">
                  {r.rsi == null ? '—' : r.rsi.toFixed(1)}
                </span>
              ),
            },
            {
              id: 'ema',
              header: 'EMA20',
              align: 'right',
              cell: (r) => (
                <span className="num">{fmtP(r.ema, digitsFor(r.symbol))}</span>
              ),
            },
            {
              id: 'upd',
              header: 'Updated',
              muted: true,
              cell: (r) =>
                r.lastUpdate
                  ? timeOf(r.lastUpdate)
                  : r.hasReceived
                    ? '—'
                    : 'waiting',
            },
          ]}
          data={st.symbolsLive}
          getRowId={(r) => r.symbol}
          caption="Strategy market feed"
          empty="No symbols"
        />
      </Panel>
      <Box sx={{ gridColumn: { lg: '1 / -1' }, minHeight: 240 }}>
        <Panel title="Strategy log" dense>
          <ActorLog lines={lines} />
        </Panel>
      </Box>
    </Box>
  );
}
