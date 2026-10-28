import { describe, expect, it } from 'vitest';
import { settings } from '../../../test/fixtures';
import { aiModeChangedLog, dailyStopNote, quotaView } from './ai';

const calls = (used: number, max: number) =>
  settings({
    ai_max_calls_per_day: max,
    ai_calls: { date_utc: '2026-10-28', used, max, remaining: null },
  });

describe('quotaView', () => {
  it.each([
    [3, 10, '3 / 10 ครั้ง', 30, '', false],
    [7, 10, '7 / 10 ครั้ง', 70, 'warn', false],
    [10, 10, '10 / 10 ครั้ง', 100, 'full', true],
    [12, 10, '12 / 10 ครั้ง', 100, 'full', true],
    [5, 0, '5 ครั้ง (ไม่จำกัด)', 0, '', false],
  ] as const)('%i of %i', (used, max, text, pct, barClass, full) => {
    expect(quotaView(calls(used, max))).toEqual({
      text,
      pct,
      barClass,
      full,
      dateUtc: '2026-10-28',
    });
  });
});

describe('dailyStopNote', () => {
  const t = () => '14:05';

  it('daily stop switched off', () => {
    expect(dailyStopNote(settings({ daily_max_loss_usd: 0 }), t)).toBe(
      'daily stop ปิดอยู่ (ตั้งเป็น 0) — ไม่มีอะไรให้เคลียร์',
    );
  });

  it('P&L not read yet', () => {
    expect(dailyStopNote(settings({ daily_pnl: null }), t)).toBe(
      'ยังไม่ได้อ่าน P&L วันนี้ (บอทจะอ่านตอนรอบวิเคราะห์ถัดไป) · เพดาน -$400',
    );
  });

  it('blocked at exactly the limit, open below it, with the reset time', () => {
    expect(dailyStopNote(settings({ daily_pnl: -400 }), t)).toBe(
      '🔴 ตอนนี้โดนบล็อกอยู่: ขาดทุนวันนี้ -400.00 USD · เพดาน -$400',
    );
    expect(
      dailyStopNote(
        settings({
          daily_pnl: -12.5,
          daily_stop_reset_at: '2026-10-28T07:05:00Z',
        }),
        t,
      ),
    ).toBe(
      '🟢 ยังไม่ชนเพดาน: ขาดทุนวันนี้ -12.50 USD · เพดาน -$400 · เคยเคลียร์แล้วเมื่อ 14:05 (นับใหม่ตั้งแต่เวลานั้น)',
    );
  });
});

describe('aiModeChangedLog', () => {
  it('lead is logged as a warning', () => {
    expect(aiModeChangedLog('lead').level).toBe('warn');
    expect(aiModeChangedLog('off')).toEqual({
      message: 'ปิด AI แล้ว — กลับไปใช้ TA ล้วน',
      level: 'info',
    });
  });
});
