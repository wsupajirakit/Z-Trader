import PlayArrow from '@mui/icons-material/PlayArrow';
import Stop from '@mui/icons-material/Stop';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type { GoldMode } from '../../api/types';
import { useDialogs } from '../../components/dialogs/context';
import { settingsQuery, statusQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { useInstruments } from '../../data/useInstruments';
import { capsLabel } from '../../theme/theme';
import { useCan } from '../auth/session';

const MODES: readonly GoldMode[] = ['scalp', 'intraday', 'swing', 'position'];

/**
 * Start/stop the automated loop with the instruments and modes to trade. While the loop runs the
 * boxes mirror the server and are locked; when stopped they are free (seeded from the server).
 */
export function ExecutionControl() {
  const { data: status } = useQuery(statusQuery);
  const { data: settings } = useQuery(settingsQuery);
  const { symbols, active } = useInstruments();
  const canOperate = useCan('operator');
  const dialogs = useDialogs();
  const running = !!status?.enabled;
  const [modes, setModes] = useState<GoldMode[] | null>(null);
  const [insts, setInsts] = useState<string[] | null>(null);
  const shownModes =
    running || !modes
      ? status?.modes.length
        ? status.modes
        : ['swing' as GoldMode]
      : modes;
  const shownInsts =
    running || !insts
      ? status?.enabled_instruments.length
        ? status.enabled_instruments
        : [active]
      : insts;

  const automate = useAction({
    fn: (enabled: boolean) =>
      dashboardApi.automate(
        enabled
          ? { enabled, modes: [...shownModes], instruments: [...shownInsts] }
          : { enabled },
      ),
    invalidate: [qk.dashboard.status, qk.dashboard.settings],
    success: (_r, enabled) =>
      enabled
        ? `Loop started · ${shownInsts.join(', ')} · ${shownModes.join('/')}`
        : 'Loop stopped',
    failure: (m, enabled) =>
      `Could not ${enabled ? 'start' : 'stop'} the loop: ${m}`,
    tag: 'loop',
    onSuccess: () => {
      setModes(null);
      setInsts(null);
    },
  });

  const blocked = (sym: string) => status?.blocked_modes[sym] ?? [];
  const start = async () => {
    if (!shownModes.length || !shownInsts.length) {
      await dialogs.alert(
        'Nothing selected',
        'Pick at least one instrument and one mode before starting the loop.',
      );
      return;
    }
    const live = status?.accountMode === 'LIVE';
    const ok = await dialogs.confirm({
      title: live ? 'Start the loop on a LIVE account' : 'Start the loop',
      message: (
        <>
          The bot will analyse and place orders automatically on{' '}
          <b>{status?.accountMode ?? 'DEMO'}</b>.
        </>
      ),
      details: (
        <Box
          sx={{
            fontSize: 12,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '4px 12px',
          }}
        >
          <Box sx={{ color: 'text.secondary' }}>Instruments</Box>
          <b>{shownInsts.join(', ')}</b>
          <Box sx={{ color: 'text.secondary' }}>Modes</Box>
          <b>{shownModes.join(', ')}</b>
          <Box sx={{ color: 'text.secondary' }}>Risk profile</Box>
          <b>
            {settings?.risk_profile
              ? `${settings.risk_profile.name}${settings.risk_profile.modified ? ' (modified)' : ''}`
              : 'custom settings'}
          </b>
          <Box sx={{ color: 'text.secondary' }}>Risk / trade</Box>
          <b>${settings?.risk_usd_per_trade ?? '—'}</b>
          <Box sx={{ color: 'text.secondary' }}>Daily stop</Box>
          <b>${settings?.daily_max_loss_usd ?? '—'}</b>
        </Box>
      ),
      confirmLabel: 'Start loop',
      tone: live ? 'danger' : 'primary',
      ...(live ? { requireText: 'LIVE' } : {}),
    });
    if (ok) automate.mutate(true);
  };

  const lock = running || !canOperate;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        <Box
          sx={{
            ...capsLabel,
            fontSize: 11,
            color: running ? 'terminal.up' : 'text.secondary',
            flex: 1,
          }}
        >
          {running ? '● Loop running' : '○ Loop stopped'}
        </Box>
        {canOperate ? (
          running ? (
            <Button
              variant="contained"
              color="error"
              startIcon={<Stop />}
              disabled={automate.isPending}
              onClick={() => {
                automate.mutate(false);
              }}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="contained"
              color="success"
              startIcon={<PlayArrow />}
              disabled={automate.isPending}
              onClick={() => void start()}
            >
              Start
            </Button>
          )
        ) : null}
      </Box>
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
                      setInsts(
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
                    setModes(
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
      {shownInsts.some((s) =>
        shownModes.some((m) => blocked(s).includes(m)),
      ) ? (
        <Alert severity="warning" variant="outlined">
          Some selected modes are disabled for an instrument and will be
          skipped:{' '}
          {shownInsts
            .map(
              (s) =>
                [s, shownModes.filter((m) => blocked(s).includes(m))] as const,
            )
            .filter(([, b]) => b.length)
            .map(([s, b]) => `${s} (${b.join(', ')})`)
            .join(' · ')}
        </Alert>
      ) : null}
    </Box>
  );
}
