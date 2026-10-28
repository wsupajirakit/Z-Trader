import { useMutation, useQuery } from '@tanstack/react-query';
import { describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import type { GoldMode, ModeState, PendingSummary } from '../../../api/types';
import { dialogs } from '../../../lib/dialogs';
import { timeTh } from '../../../lib/time';
import { Can } from '../../auth/Can';
import { useActivityLog } from '../activity/ActivityLogContext';
import { useModes } from '../automate/useModes';
import { useActiveInstrument } from '../instruments/useActiveInstrument';
import { statusQuery } from '../queries';
import { useInvalidateDashboard } from '../useInvalidateDashboard';
import { aiLine, decisionText, outcomeClass } from './modeCard';

/** Live Stats: one card per mode — last run, pending decision, outcome, decision, AI verdict. */
export function LiveStatsCard() {
  const { data: s } = useQuery(statusQuery);
  const modes = useModes();
  const allModes = modes.length
    ? modes.map((m) => m.mode)
    : Object.keys(s?.state ?? {});

  return (
    <div className="card">
      <h2>
        Live Stats{' '}
        <span className="muted">
          {s
            ? '· loop ' +
              (s.enabled ? '🟢 ON: ' + s.modes.join(', ') : '⚪ OFF')
            : ''}
        </span>
      </h2>
      <div className="statgrid">
        {s ? (
          allModes.map((m) => (
            <ModeCard
              key={m}
              mode={m}
              state={s.state[m]}
              pending={s.pending[m]}
            />
          ))
        ) : (
          <div className="muted">กำลังโหลด…</div>
        )}
      </div>
    </div>
  );
}

function ModeCard({
  mode,
  state,
  pending,
}: {
  mode: string;
  state: ModeState | undefined;
  pending: PendingSummary | undefined;
}) {
  const { active } = useActiveInstrument();
  const dec = decisionText(state?.lastDecision, active.digits);
  const ai = state?.lastAssist ? aiLine(state.lastAssist, active.digits) : null;

  return (
    <div className="mode-card">
      <div className="mc-head">
        <span className="mc-name">{mode}</span>
        <span className="mc-time">
          {state?.lastRunAt ? timeTh(state.lastRunAt) : 'ยังไม่เคยรัน'}
        </span>
      </div>
      {pending ? (
        <PendingDecision mode={mode as GoldMode} pending={pending} />
      ) : null}
      <div className={'mc-outcome ' + outcomeClass(state?.lastOutcome)}>
        {state?.lastOutcome || '—'}
      </div>
      {dec ? <div className="mc-dec">{dec}</div> : null}
      {ai ? (
        <div className={ai.className} title={ai.title}>
          {ai.text}
        </div>
      ) : null}
    </div>
  );
}

/** A decision parked by "วิเคราะห์ก่อน": fire it (✓ ยิง) or drop it (✕ ปัดตก). */
function PendingDecision({
  mode,
  pending,
}: {
  mode: GoldMode;
  pending: PendingSummary;
}) {
  const log = useActivityLog();
  const invalidate = useInvalidateDashboard();

  const confirm = useMutation({
    mutationFn: () => dashboardApi.confirm(mode, pending.id),
    onSuccess: (d) => {
      log.append('ยิง order แล้ว: ' + d.uuid, 'order', mode);
    },
    onError: (e) => {
      log.append('❌ ' + (describeError(e) || 'ยิงไม่สำเร็จ'), 'error', mode);
    },
    onSettled: () => {
      invalidate('status', 'positions');
    },
  });

  const reject = useMutation({
    mutationFn: (reason: string) =>
      dashboardApi.reject(mode, pending.id, reason),
    onSuccess: (_, reason) => {
      log.append('ปัดตก: ' + reason, 'warn', mode);
    },
    onError: (e) => {
      log.append('❌ ' + describeError(e), 'error', mode);
    },
    onSettled: () => {
      invalidate('status');
    },
  });

  const busy = confirm.isPending || reject.isPending;

  return (
    <>
      <div className="mc-outcome wait">
        ⏳ รอตรวจ (เหลือ {pending.ttl_sec}s): {pending.order}
      </div>
      <Can role="operator">
        <div className="pend-actions">
          <button
            type="button"
            className="btn-start"
            disabled={busy}
            onClick={() => {
              if (dialogs.confirm('ยืนยันยิง order นี้เข้า cTrader?'))
                confirm.mutate();
            }}
          >
            ✓ ยิง
          </button>
          <button
            type="button"
            className="btn-stop"
            disabled={busy}
            onClick={() => {
              const reason = dialogs.prompt('เหตุผลที่ปัดตก:', 'ไม่เข้าเกณฑ์');
              if (reason !== null) reject.mutate(reason);
            }}
          >
            ✕ ปัดตก
          </button>
        </div>
      </Can>
    </>
  );
}
