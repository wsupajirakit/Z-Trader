import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import { useDialogs } from '../../components/dialogs/context';
import { Stat } from '../../components/Panel';
import { settingsQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { money, timeOf, usd } from '../../lib/format';
import { useCan } from '../auth/session';

/**
 * Today's P&L against the daily stop, and the kill-switch reset (clears today's stop so the
 * bot may trade again). Reset needs operator and a typed confirmation.
 */
export function DailyStopCard() {
  const { data: s } = useQuery(settingsQuery);
  const canOperate = useCan('operator');
  const dialogs = useDialogs();
  const reset = useAction({
    fn: () => dashboardApi.resetDailyStop(),
    invalidate: [qk.dashboard.settings, qk.dashboard.status],
    success: (r) =>
      `Daily stop cleared (P&L before ${r.pnl_before == null ? 'n/a' : money(r.pnl_before)})`,
    failure: (m) => `Could not clear the daily stop: ${m}`,
    tag: 'risk',
  });
  if (!s) return null;
  const pnl = s.daily_pnl;
  const stop = s.daily_max_loss_usd;
  const used =
    pnl != null && pnl < 0 && stop > 0 ? Math.min(100, (-pnl / stop) * 100) : 0;
  const hit = pnl != null && stop > 0 && pnl <= -stop && !s.daily_stop_reset_at;

  return (
    <Box>
      <Stat
        label="Today P&L"
        value={pnl == null ? '—' : money(pnl)}
        tone={pnl == null ? 'muted' : pnl >= 0 ? 'up' : 'down'}
      />
      <Stat label="Daily stop" value={stop > 0 ? usd(-stop, 0) : 'off'} />
      <Tooltip title={`${used.toFixed(0)}% of the daily stop used`}>
        <LinearProgress
          variant="determinate"
          value={used}
          color={used >= 100 ? 'error' : used >= 70 ? 'warning' : 'success'}
          sx={{ my: 1.5 }}
          aria-label="Daily stop used"
        />
      </Tooltip>
      {hit ? (
        <Box
          sx={{
            color: 'terminal.down',
            fontSize: 11,
            mb: 1.5,
            fontWeight: 600,
          }}
        >
          Daily stop hit — the bot stopped opening trades today.
        </Box>
      ) : null}
      {s.daily_stop_reset_at ? (
        <Box sx={{ color: 'warning.main', fontSize: 11, mb: 1.5 }}>
          Stop was cleared today at {timeOf(s.daily_stop_reset_at)}.
        </Box>
      ) : null}
      {canOperate ? (
        <Button
          fullWidth
          variant="outlined"
          color="error"
          disabled={reset.isPending}
          onClick={async () => {
            const ok = await dialogs.confirm({
              title: 'Clear today’s daily stop',
              message:
                'The bot will be allowed to open new trades again today even though the daily loss limit was reached. Losses can grow beyond the stop.',
              confirmLabel: 'Clear stop',
              tone: 'danger',
              requireText: 'RESET',
            });
            if (ok) reset.mutate(undefined);
          }}
        >
          Kill switch · clear daily stop
        </Button>
      ) : null}
    </Box>
  );
}
