import PlayArrow from '@mui/icons-material/PlayArrow';
import Stop from '@mui/icons-material/Stop';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import Tooltip from '@mui/material/Tooltip';
import type { GoldMode } from '../../api/types';
import { capsLabel } from '../../theme/theme';
import type { LoopControl } from './useLoopControl';

const MODES: readonly GoldMode[] = ['scalp', 'intraday', 'swing', 'position'];

export function LoopAction({ loop }: { loop: LoopControl }) {
  if (!loop.canOperate) return null;
  return loop.running ? (
    <Button
      variant="contained"
      color="error"
      size="small"
      startIcon={<Stop />}
      disabled={loop.pending}
      onClick={() => {
        void loop.stop().catch(() => undefined); // the failure is already logged and shown
      }}
    >
      Stop
    </Button>
  ) : (
    <Button
      variant="contained"
      color="success"
      size="small"
      startIcon={<PlayArrow />}
      disabled={loop.pending}
      onClick={() => void loop.start()}
    >
      Start
    </Button>
  );
}

export function LoopSettings({ loop }: { loop: LoopControl }) {
  const { status, symbols, running, shownModes, shownInsts } = loop;
  const lock = running || !loop.canOperate;
  const blocked = (sym: string) => status?.blocked_modes[sym] ?? [];
  const skipped = shownInsts
    .map((s) => [s, shownModes.filter((m) => blocked(s).includes(m))] as const)
    .filter(([, b]) => b.length);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Box
          sx={{ ...capsLabel, fontSize: 10, color: 'text.secondary', mb: 0.5 }}
        >
          Instruments
        </Box>
        <FormGroup row>
          {symbols.map((s) => (
            <Tooltip key={s} title={running ? 'Stop the loop to change' : ''}>
              <FormControlLabel
                label={<span className="num">{s}</span>}
                control={
                  <Checkbox
                    checked={shownInsts.includes(s)}
                    disabled={lock}
                    onChange={(e) => {
                      loop.setInsts(
                        e.target.checked
                          ? [...shownInsts, s]
                          : shownInsts.filter((x) => x !== s),
                      );
                    }}
                  />
                }
              />
            </Tooltip>
          ))}
        </FormGroup>
      </Box>
      <Box>
        <Box
          sx={{ ...capsLabel, fontSize: 10, color: 'text.secondary', mb: 0.5 }}
        >
          Modes
        </Box>
        <FormGroup row>
          {MODES.map((m) => (
            <FormControlLabel
              key={m}
              label={m}
              control={
                <Checkbox
                  checked={shownModes.includes(m)}
                  disabled={lock}
                  onChange={(e) => {
                    loop.setModes(
                      e.target.checked
                        ? [...shownModes, m]
                        : shownModes.filter((x) => x !== m),
                    );
                  }}
                />
              }
            />
          ))}
        </FormGroup>
      </Box>
      {skipped.length ? (
        <Alert severity="warning" variant="outlined">
          Some selected modes are disabled for an instrument and will be
          skipped:{' '}
          {skipped.map(([s, b]) => `${s} (${b.join(', ')})`).join(' · ')}
        </Alert>
      ) : null}
    </Box>
  );
}
