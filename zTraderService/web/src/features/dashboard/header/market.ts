import type { MarketStatus } from '../../../api/types';
import { fmtHM } from '../../../lib/format';

/** The single-instrument market badge: open → time to close, closed → time to open. */
export function marketBadge(mk: MarketStatus): {
  className: string;
  text: string;
  title: string;
} {
  if (mk.open) {
    return {
      className: 'badge mkt-open',
      text: '🟢 ตลาดเปิด · ปิดอีก ' + fmtHM(mk.minutes_to_close),
      title: mk.reason,
    };
  }
  return {
    className: 'badge mkt-closed',
    text:
      (mk.phase === 'weekend' ? '🔴 ปิดสุดสัปดาห์' : '🟡 พักรายวัน') +
      ' · เปิดอีก ' +
      fmtHM(mk.minutes_to_open),
    title: mk.reason,
  };
}
