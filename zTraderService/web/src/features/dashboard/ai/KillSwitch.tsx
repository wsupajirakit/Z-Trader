import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import type { BotSettings } from '../../../api/types';
import { dialogs } from '../../../lib/dialogs';
import { hourMinuteTh } from '../../../lib/time';
import { Can } from '../../auth/Can';
import { useActivityLog } from '../activity/ActivityLogContext';
import { InfoButton } from '../info/InfoButton';
import { useInvalidateDashboard } from '../useInvalidateDashboard';
import { DAILY_STOP_CONFIRM, dailyStopNote } from './ai';

/**
 * Daily-stop status for everyone; the clear button for operators only.
 * "เคลียร์ daily stop" unlocks a safety guard, so it takes two steps: tick the box (which
 * enables the button), then confirm. The box is cleared after every attempt — no double clicks.
 */
export function KillSwitch({
  settings,
}: {
  settings: BotSettings | undefined;
}) {
  const [ack, setAck] = useState(false);
  const log = useActivityLog();
  const invalidate = useInvalidateDashboard();

  const reset = useMutation({
    mutationFn: dashboardApi.resetDailyStop,
    onSuccess: (d) => {
      const before =
        d.pnl_before === null
          ? 'ยังไม่เคยอ่าน'
          : d.pnl_before.toFixed(2) + ' USD';
      log.append(
        '🛑 เคลียร์ daily stop แล้ว (ขาดทุนก่อนกด ' +
          before +
          ') — เริ่มนับใหม่จากตอนนี้',
        'warn',
      );
    },
    onError: (e) => {
      log.append(
        '❌ เคลียร์ daily stop ไม่สำเร็จ: ' + describeError(e),
        'error',
      );
    },
    onSettled: () => {
      setAck(false);
      invalidate('settings', 'status');
    },
  });

  return (
    <div className="killbox">
      <div className="kh">
        🛑 เคลียร์ daily stop (ปลดด่านกันขาดทุนรายวัน){' '}
        <InfoButton k="killdaily" />
      </div>
      <div className="kn">
        {settings ? dailyStopNote(settings, hourMinuteTh) : '—'}
      </div>
      <Can role="operator">
        <label>
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => {
              setAck(e.target.checked);
            }}
          />
          <span>
            ฉันเข้าใจว่านี่คือการปลดด่านกันขาดทุน
            และยอมรับว่าบอทจะกลับมาเปิดไม้ได้ทันที
          </span>
        </label>
        <button
          type="button"
          className="btn-kill"
          disabled={!ack || reset.isPending}
          onClick={() => {
            if (ack && dialogs.confirm(DAILY_STOP_CONFIRM)) reset.mutate();
          }}
        >
          เคลียร์ daily stop
        </button>
      </Can>
    </div>
  );
}
