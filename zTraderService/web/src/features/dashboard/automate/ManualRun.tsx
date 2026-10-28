import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import type { GoldMode } from '../../../api/types';
import { Can } from '../../auth/Can';
import { useActivityLog } from '../activity/ActivityLogContext';
import type { LogLevel } from '../activity/activityLog';
import { InfoButton } from '../info/InfoButton';
import { useInvalidateDashboard } from '../useInvalidateDashboard';
import { useModes } from './useModes';

interface RunVars {
  mode: GoldMode;
  /** true = analyse and park the decision for review, never fire */
  dryRun: boolean;
}

/** What the original logged for a run: the outcome, or the whole response when there is none. */
function outcomeLine(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'outcome' in data) {
    const o = data.outcome;
    if (typeof o === 'string' && o) return o;
  }
  return JSON.stringify(data);
}

/** Mode select for manual runs + "▶ รันเลย" / "🔍 วิเคราะห์ก่อน". */
export function ManualRun() {
  const modes = useModes();
  const [picked, setPicked] = useState<GoldMode | null>(null);
  const mode = modes.find((m) => m.mode === picked) ?? modes[0];
  const log = useActivityLog();
  const invalidate = useInvalidateDashboard();

  const run = useMutation({
    mutationFn: ({ mode, dryRun }: RunVars) =>
      (dryRun ? dashboardApi.analyze : dashboardApi.run)({ mode, force: true }),
    onMutate: ({ mode, dryRun }) => {
      if (dryRun)
        log.append(
          'วิเคราะห์อย่างเดียว (พักไว้ให้ตรวจก่อน ไม่ยิง)…',
          'info',
          mode,
        );
      else log.append('สั่งรันเอง (ยิง order ได้ถ้าเจอ setup)…', 'warn', mode);
    },
    onSuccess: (data, { mode, dryRun }) => {
      const line = outcomeLine(data);
      let level: LogLevel = 'info';
      if (dryRun && line.startsWith('awaiting')) level = 'warn';
      if (!dryRun && line.startsWith('order sent')) level = 'order';
      log.append(line, level, mode);
    },
    onError: (e, { mode }) => {
      // An HTTP error body was printed as-is (JSON) by the original; a dead network is an error.
      if (e instanceof ApiError)
        log.append(JSON.stringify(e.body ?? e.message), 'info', mode);
      else log.append('❌ ' + describeError(e), 'error', mode);
    },
    onSettled: () => {
      invalidate('status');
    },
  });

  return (
    <>
      <span className="lbl m8">
        โหมด (สำหรับสั่งรันเอง) <InfoButton k="mode" />
        <span className="spacer" />
        <InfoButton k="rr" variant="pill" title="R:R คืออะไร">
          R:R คืออะไร
        </InfoButton>
      </span>
      <select
        aria-label="โหมด"
        value={mode?.mode ?? ''}
        onChange={(e) => {
          setPicked(e.target.value as GoldMode);
        }}
      >
        {modes.map((m) => (
          <option key={m.mode} value={m.mode}>
            {m.mode} — R:R ≥ {m.rr_min}
          </option>
        ))}
      </select>
      <div className="modehint">
        {mode ? mode.horizon + ' · ' + mode.tf_roles : ''}
      </div>
      <Can role="operator">
        <div className="row">
          <button
            type="button"
            className="btn-run"
            disabled={run.isPending || !mode}
            onClick={() => {
              if (mode) run.mutate({ mode: mode.mode, dryRun: false });
            }}
          >
            ▶ รันเลย
          </button>
          <button
            type="button"
            className="btn-check"
            disabled={run.isPending || !mode}
            onClick={() => {
              if (mode) run.mutate({ mode: mode.mode, dryRun: true });
            }}
          >
            🔍 วิเคราะห์ก่อน
          </button>
        </div>
      </Can>
    </>
  );
}
