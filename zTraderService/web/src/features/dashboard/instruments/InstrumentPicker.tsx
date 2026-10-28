import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import { useCan } from '../../auth/session';
import { useActivityLog } from '../activity/ActivityLogContext';
import { InfoButton } from '../info/InfoButton';
import { statusQuery } from '../queries';
import { useInvalidateDashboard } from '../useInvalidateDashboard';
import {
  blockedModesWarning,
  instrumentHint,
  instrumentOptionLabel,
  normalizeInstrument,
} from './instrument';
import { useActiveInstrument } from './useActiveInstrument';

/**
 * Instrument select — only while the loop is stopped; everything else (data, playbook,
 * AI prompt, news, market hours, lot maths) follows the server-side instrument profile.
 */
export function InstrumentPicker() {
  const qc = useQueryClient();
  const log = useActivityLog();
  const invalidate = useInvalidateDashboard();
  const canOperate = useCan('operator');
  const { data: status } = useQuery(statusQuery);
  const { active, list } = useActiveInstrument();

  const change = useMutation({
    mutationFn: (key: string) => dashboardApi.setInstrument(key),
    onMutate: (key) => {
      log.append('กำลังเปลี่ยนตราสารเป็น ' + key + '…', 'info');
    },
    onSuccess: (next) => {
      qc.setQueryData(statusQuery.queryKey, next);
      const inst = normalizeInstrument(next.instrument);
      log.append(
        '✅ เปลี่ยนตราสารเป็น ' +
          inst.emoji +
          ' ' +
          inst.key +
          ' (' +
          inst.name_th +
          ') — ข้อมูล/playbook/AI prompt/ข่าว/ชั่วโมงตลาด/lot ปรับตามแล้ว',
        'order',
      );
      invalidate('all');
    },
    onError: (e) => {
      log.append('❌ เปลี่ยนตราสารไม่สำเร็จ: ' + describeError(e), 'error');
      invalidate('status');
    },
  });

  const running = !!status?.enabled;
  const options = list.length ? list : [{ ...active, daily_range_th: '' }];
  const value = (change.isPending ? change.variables : undefined) ?? active.key;
  const warning = status ? blockedModesWarning(status, active.key) : null;

  return (
    <>
      <span className="lbl m8">
        ตราสาร (instrument) <InfoButton k="instrument" />
      </span>
      <select
        aria-label="ตราสาร"
        value={value}
        disabled={running || change.isPending || !canOperate}
        title={
          running
            ? 'เปลี่ยนตราสารได้เฉพาะตอน loop หยุด — กด Stop Auto Loop ก่อน'
            : 'เลือกตราสารที่บอทจะเทรด'
        }
        onChange={(e) => {
          const key = e.target.value;
          if (key && key !== active.key && !change.isPending)
            change.mutate(key);
        }}
      >
        {options.map((i) => (
          <option key={i.key} value={i.key}>
            {instrumentOptionLabel(i)}
          </option>
        ))}
      </select>
      <div className="modehint">{instrumentHint(active, list)}</div>
      {warning ? (
        <div className="instwarn" role="note">
          ⚠️{' '}
          <b>
            {warning.key} ปิดโหมด {warning.blocked.join(' / ')} ไว้
          </b>{' '}
          — loop เทรดเฉพาะ{' '}
          <b>
            {warning.tradable.length
              ? warning.tradable.join(' / ')
              : 'ไม่มีโหมดเหลือ'}
          </b>
          <span className="why">
            ไม้ต่ำสุดที่ broker รับคือ 0.01 lot ซึ่งของทองเสี่ยง ~$1 ต่อการวิ่ง
            1 จุด · โหมด SL กว้าง (swing ~35 จุด) ไม้ต่ำสุดก็เสี่ยง ~$35 แล้ว{' '}
            <b>ลดกว่านี้ไม่ได้</b> ตั้งงบเสี่ยงต่อไม้เท่าไหร่ก็ไม่มีผล —
            คู่เงินไม่เจอปัญหานี้เพราะ 0.01 lot เสี่ยงแค่หลักสตางค์
            <br />
            ยอมรับความเสี่ยงแล้วอยากเปิดเอง: ตั้ง{' '}
            <code>GOLD_MODES_{warning.key}=scalp,intraday,swing</code> ใน .env
          </span>
        </div>
      ) : null}
    </>
  );
}
