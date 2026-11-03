import Box from '@mui/material/Box';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type { GoldMode } from '../../api/types';
import { useDialogs } from '../../components/dialogs/context';
import { settingsQuery, statusQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { useInstruments } from '../../data/useInstruments';
import { useCan } from '../auth/session';

/**
 * The automated loop: instruments and modes to trade, start (confirmed) and stop. While the loop
 * runs the boxes mirror the server and are locked; when stopped they are free (seeded from the
 * server). The Start/Stop button and the settings render separately (ExecutionPanel puts the
 * button in the section header so it never scrolls out of view).
 */
export function useLoopControl() {
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

  return {
    status,
    symbols,
    running,
    canOperate,
    pending: automate.isPending,
    shownModes,
    shownInsts,
    setModes,
    setInsts,
    start,
    /** resolves once the server has stopped the loop; rejects when it could not */
    stop: () => automate.mutateAsync(false),
  };
}

export type LoopControl = ReturnType<typeof useLoopControl>;
