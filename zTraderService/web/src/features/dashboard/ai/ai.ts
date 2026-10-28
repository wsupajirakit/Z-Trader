import type {
  AiGate,
  AiMode,
  BotSettings,
  ThinkingLevel,
} from '../../../api/types';

/** Gemini thinking levels (Google docs): value, Thai label, explanation. */
export const THINK_LEVELS: readonly {
  value: ThinkingLevel;
  th: string;
  note: string;
}[] = [
  {
    value: 'minimal',
    th: 'ต่ำสุด',
    note: 'เร็ว/ถูกที่สุด — แทบไม่คิดก่อนตอบ เหมาะกับงานตรงไปตรงมา',
  },
  { value: 'low', th: 'ต่ำ', note: 'คิดสั้น ๆ พอ — สมดุลความเร็วกับคุณภาพ' },
  {
    value: 'medium',
    th: 'กลาง',
    note: 'คิดมากขึ้น ตอบรอบคอบกว่า ใช้ token เพิ่ม',
  },
  {
    value: 'high',
    th: 'สูง',
    note: 'คิดหนักสุด ช้าและกิน token มาก — งบ max_tokens ต้องเผื่อเยอะ',
  },
];

export const AI_MODES: readonly { value: AiMode; th: string; sub: string }[] = [
  { value: 'off', th: 'ปิด', sub: 'ใช้ TA ล้วน' },
  { value: 'assist', th: 'ผู้ตรวจ', sub: 'TA หาไม้ → AI ขัด/ปัดตก' },
  { value: 'lead', th: 'นักวิเคราะห์', sub: '+ AI หาไม้เองเมื่อ TA ไม่เจอ' },
];

export const AI_GATES: readonly { value: AiGate; th: string; sub: string }[] = [
  { value: 'setup_only', th: 'เฉพาะมีไม้', sub: '~5 ครั้ง/วัน' },
  { value: 'near_miss', th: 'เฉียดด้วย', sub: '~29 ครั้ง/วัน' },
  { value: 'always', th: 'ทุกรอบ', sub: '~68 ครั้ง/วัน' },
];

/** Log line after a successful AI-role switch, and its level. */
export function aiModeChangedLog(m: AiMode): {
  message: string;
  level: 'warn' | 'info';
} {
  if (m === 'lead') {
    return {
      message:
        '🤖 AI = นักวิเคราะห์ — TA ไม่เจอ setup เมื่อไหร่ AI จะหาไม้เอง (ขนาดไม่เกินครึ่ง)',
      level: 'warn',
    };
  }
  if (m === 'assist') {
    return {
      message: '🤖 AI = ผู้ตรวจ — ตรวจไม้ที่ TA หามา ลดความเสี่ยงได้อย่างเดียว',
      level: 'info',
    };
  }
  return { message: 'ปิด AI แล้ว — กลับไปใช้ TA ล้วน', level: 'info' };
}

export interface QuotaView {
  text: string;
  /** 0–100, bar width */
  pct: number;
  barClass: '' | 'warn' | 'full';
  full: boolean;
  dateUtc: string;
}

/**
 * AI call quota of the UTC day. Hitting the cap does not stop the bot — it falls back to TA
 * until the next UTC day or a reset.
 */
export function quotaView(
  s: Pick<BotSettings, 'ai_calls' | 'ai_max_calls_per_day'>,
): QuotaView {
  const used = s.ai_calls.used || 0;
  const max = s.ai_max_calls_per_day;
  const unlimited = !max || max <= 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / max) * 100));
  return {
    text: unlimited ? `${used} ครั้ง (ไม่จำกัด)` : `${used} / ${max} ครั้ง`,
    pct,
    barClass: pct >= 100 ? 'full' : pct >= 70 ? 'warn' : '',
    full: !unlimited && used >= max,
    dateUtc: s.ai_calls.date_utc || '-',
  };
}

/** Daily-stop status line inside the kill box. */
export function dailyStopNote(
  s: Pick<
    BotSettings,
    'daily_pnl' | 'daily_max_loss_usd' | 'daily_stop_reset_at'
  >,
  formatTime: (iso: string) => string,
): string {
  const pnl = s.daily_pnl;
  const lim = s.daily_max_loss_usd || 0;
  let txt: string;
  if (!lim) txt = 'daily stop ปิดอยู่ (ตั้งเป็น 0) — ไม่มีอะไรให้เคลียร์';
  else if (pnl === null) {
    txt =
      'ยังไม่ได้อ่าน P&L วันนี้ (บอทจะอ่านตอนรอบวิเคราะห์ถัดไป) · เพดาน -$' +
      lim;
  } else {
    const blocked = pnl <= -lim;
    txt =
      (blocked ? '🔴 ตอนนี้โดนบล็อกอยู่: ' : '🟢 ยังไม่ชนเพดาน: ') +
      'ขาดทุนวันนี้ ' +
      pnl.toFixed(2) +
      ' USD · เพดาน -$' +
      lim;
  }
  if (s.daily_stop_reset_at) {
    txt +=
      ' · เคยเคลียร์แล้วเมื่อ ' +
      formatTime(s.daily_stop_reset_at) +
      ' (นับใหม่ตั้งแต่เวลานั้น)';
  }
  return txt;
}

export const DAILY_STOP_CONFIRM =
  'ยืนยันเคลียร์ daily stop?\n\n' +
  'บอทจะกลับมาเปิดไม้ได้ทันที โดยไม่สนขาดทุนที่เกิดไปแล้ววันนี้\n' +
  'ด่านไม่ได้หายไป — ขาดทุนที่เกิด "หลังจากนี้" ยังนับใหม่และตัดได้อีกถ้าถึงเพดาน';
