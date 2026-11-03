import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import type { GoldMode } from '../../api/types';
import type { SingleRun } from './useSingleRun';

export function SingleRunActions({ single }: { single: SingleRun }) {
  if (!single.canOperate) return null;
  const off = single.pending || single.loopRunning;
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      <Tooltip title="Analyze and hold the decision for your review (no order until you fire it)">
        <span>
          <Button
            variant="outlined"
            size="small"
            disabled={off}
            onClick={() => void single.fire(true)}
          >
            Analyze
          </Button>
        </span>
      </Tooltip>
      <Tooltip title="Analyze and place the order straight away if every guard passes">
        <span>
          <Button
            variant="contained"
            size="small"
            disabled={off}
            onClick={() => void single.fire(false)}
          >
            Run now
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
}

export function SingleRunSettings({ single }: { single: SingleRun }) {
  const { modes } = single;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {single.loopRunning ? (
        <Alert severity="info" variant="outlined">
          The auto loop is running. Stop it before running a single round.
        </Alert>
      ) : null}
      <TextField
        select
        label={`Mode · ${single.active}`}
        value={single.mode}
        disabled={!single.canOperate}
        onChange={(e) => {
          single.setMode(e.target.value as GoldMode);
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
    </Box>
  );
}
