import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type { GoldMode } from '../../api/types';
import { useDialogs } from '../../components/dialogs/context';
import { EmptyState } from '../../components/States';
import { statusQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { useInstruments } from '../../data/useInstruments';
import { fmtAge, timeOf } from '../../lib/format';
import { capsLabel } from '../../theme/theme';
import { useCan } from '../auth/session';
import { aiLine, decisionText, outcomeTone, summaryOf } from './decision';

const TONE_COLOR = {
  ok: 'terminal.up',
  err: 'terminal.down',
  wait: 'warning.main',
  no: 'text.secondary',
} as const;

/** one card per mode: last round, decision, AI verdict, and a parked decision to fire or reject */
export function ModeCards() {
  const { data: status } = useQuery(statusQuery);
  const { active, digitsFor } = useInstruments();
  const canOperate = useCan('operator');
  const dialogs = useDialogs();
  const digits = digitsFor(active);
  const fire = useAction({
    fn: (v: { mode: GoldMode; id: string }) =>
      dashboardApi.confirm(v.mode, v.id),
    invalidate: [qk.dashboard.status, qk.dashboard.positionsAll],
    success: (r, v) =>
      `Fired ${v.mode}: ${r.decision.order_type} (order ${r.uuid.slice(0, 8)})`,
    failure: (m, v) => `Could not fire ${v.mode}: ${m}`,
    tag: 'review',
  });
  const reject = useAction({
    fn: (v: { mode: GoldMode; id: string; reason: string }) =>
      dashboardApi.reject(v.mode, v.id, v.reason),
    invalidate: [qk.dashboard.status],
    success: (r, v) =>
      r.rejected
        ? `Rejected the ${v.mode} decision`
        : `The ${v.mode} decision had already expired`,
    failure: (m) => `Reject failed: ${m}`,
    tag: 'review',
  });

  const entries = Object.entries(status?.state ?? {});
  if (!entries.length)
    return (
      <EmptyState>
        No analysis round yet — start the loop or run one manually.
      </EmptyState>
    );

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 2,
      }}
    >
      {entries.map(([mode, st]) => {
        const pend = status?.pending[mode];
        const dec = st.lastDecision;
        const tone = outcomeTone(st.lastOutcome);
        const ai = st.lastAssist ? aiLine(st.lastAssist, digits) : null;
        const text = decisionText(dec, digits);
        return (
          <Paper
            key={mode}
            sx={{
              p: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              borderColor: pend ? 'warning.main' : undefined,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                sx={{
                  ...capsLabel,
                  color: 'primary.main',
                  fontSize: 11,
                  flex: 1,
                }}
              >
                {mode}
              </Box>
              {status?.modes.includes(mode as GoldMode) && status.enabled ? (
                <Chip color="success" variant="outlined" label="in loop" />
              ) : null}
              <Box
                sx={{ color: 'text.secondary', fontSize: 10.5 }}
                className="num"
              >
                {st.lastRunAt ? timeOf(st.lastRunAt) : 'never'}
              </Box>
            </Box>
            <Tooltip title={st.lastError ?? st.lastOutcome ?? ''}>
              <Box
                sx={{
                  color: TONE_COLOR[tone],
                  fontSize: 11.5,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {st.lastError
                  ? `error: ${st.lastError}`
                  : (st.lastOutcome ?? '—')}
              </Box>
            </Tooltip>
            {text ? (
              <Box className="num" sx={{ fontSize: 11.5 }}>
                {text}
              </Box>
            ) : dec ? (
              <Tooltip title={summaryOf(dec)}>
                <Box sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                  NO TRADE · {dec.reason}
                </Box>
              </Tooltip>
            ) : null}
            {ai ? (
              <Tooltip
                title={<Box sx={{ whiteSpace: 'pre-line' }}>{ai.detail}</Box>}
              >
                <Box
                  sx={{
                    fontSize: 11,
                    color:
                      ai.verdict === 'VETO'
                        ? 'terminal.down'
                        : ai.verdict === 'CONFIRM'
                          ? 'terminal.up'
                          : 'info.main',
                  }}
                >
                  {ai.text}
                </Box>
              </Tooltip>
            ) : null}
            {pend ? (
              <Box
                sx={{
                  mt: 1,
                  p: 1.5,
                  border: 1,
                  borderColor: 'warning.main',
                  borderRadius: 0.5,
                  bgcolor: 'action.hover',
                }}
              >
                <Box sx={{ ...capsLabel, fontSize: 10, color: 'warning.main' }}>
                  Awaiting review · expires in{' '}
                  {fmtAge(Math.max(0, pend.ttl_sec - pend.age_sec))}
                </Box>
                <Box className="num" sx={{ fontSize: 11.5, my: 1 }}>
                  {pend.order}
                </Box>
                {canOperate ? (
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button
                      size="small"
                      variant="contained"
                      color="success"
                      disabled={fire.isPending}
                      onClick={async () => {
                        const ok = await dialogs.confirm({
                          title: `Fire the ${mode} order`,
                          message: (
                            <>
                              Send this order to <b>{status.accountMode}</b>{' '}
                              now?
                            </>
                          ),
                          details: <Box className="num">{pend.order}</Box>,
                          confirmLabel: 'Fire',
                          tone:
                            status.accountMode === 'LIVE'
                              ? 'danger'
                              : 'primary',
                        });
                        if (ok)
                          fire.mutate({ mode: mode as GoldMode, id: pend.id });
                      }}
                    >
                      Fire
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      disabled={reject.isPending}
                      onClick={async () => {
                        const reason = await dialogs.prompt({
                          title: `Reject the ${mode} decision`,
                          label: 'Reason (optional)',
                          submitLabel: 'Reject',
                        });
                        if (reason !== null)
                          reject.mutate({
                            mode: mode as GoldMode,
                            id: pend.id,
                            reason:
                              reason.trim() || 'Rejected from the dashboard',
                          });
                      }}
                    >
                      Reject
                    </Button>
                  </Box>
                ) : null}
              </Box>
            ) : null}
          </Paper>
        );
      })}
    </Box>
  );
}
