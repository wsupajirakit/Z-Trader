import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type { GoldMode } from '../../api/types';
import { modesQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { useInstruments } from '../../data/useInstruments';
import { useCan } from '../auth/session';

/** one analysis round now: "Run" may place an order, "Analyze" parks the decision for review */
export function ManualRun() {
  const { active } = useInstruments();
  const { data } = useQuery(modesQuery(active));
  const canOperate = useCan('operator');
  const [mode, setMode] = useState<GoldMode>('swing');
  const modes = data?.modes ?? [];
  const run = useAction({
    fn: (v: { mode: GoldMode; analyzeOnly: boolean }) =>
      v.analyzeOnly
        ? dashboardApi.analyze({ mode: v.mode, force: true })
        : dashboardApi.run({ mode: v.mode, force: true }),
    invalidate: [qk.dashboard.status, qk.dashboard.positionsAll],
    success: (r, v) =>
      `${v.analyzeOnly ? 'Analyze' : 'Run'} ${v.mode}: ${r.outcome}`,
    failure: (m, v) =>
      `${v.analyzeOnly ? 'Analyze' : 'Run'} ${v.mode} failed: ${m}`,
    tag: 'manual',
  });
  if (!canOperate) return null;
  return (
    <Box
      sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}
    >
      <TextField
        select
        label="Mode"
        value={
          modes.some((m) => m.mode === mode) || !modes.length
            ? mode
            : (modes[0]?.mode ?? 'swing')
        }
        onChange={(e) => {
          setMode(e.target.value as GoldMode);
        }}
        sx={{ minWidth: 220 }}
      >
        {(modes.length
          ? modes
          : [{ mode: 'swing' as GoldMode, horizon: '', rr_min: 0 }]
        ).map((m) => (
          <MenuItem key={m.mode} value={m.mode}>
            {m.mode}
            {m.horizon ? ` · ${m.horizon}` : ''}
            {m.rr_min ? ` · R:R ≥ ${m.rr_min}` : ''}
          </MenuItem>
        ))}
      </TextField>
      <Tooltip title="Analyze and hold the decision for your review (no order until you fire it)">
        <span>
          <Button
            variant="outlined"
            disabled={run.isPending}
            onClick={() => {
              run.mutate({ mode, analyzeOnly: true });
            }}
          >
            Analyze
          </Button>
        </span>
      </Tooltip>
      <Tooltip title="Analyze and place the order straight away if every guard passes">
        <span>
          <Button
            variant="contained"
            disabled={run.isPending}
            onClick={() => {
              run.mutate({ mode, analyzeOnly: false });
            }}
          >
            Run now
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
}
