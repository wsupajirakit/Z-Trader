import { describe, expect, it } from 'vitest';
import { status } from '../../../test/fixtures';
import { marketBadge } from './market';

describe('marketBadge', () => {
  it('open → time until close', () => {
    expect(marketBadge(status().market)).toEqual({
      className: 'badge mkt-open',
      text: '🟢 ตลาดเปิด · ปิดอีก 7:05',
      title: 'ตลาดทองเปิด (10:00 ET)',
    });
  });

  it('weekend / daily break → time until open', () => {
    const closed = { ...status().market, open: false, minutes_to_close: null };
    expect(
      marketBadge({ ...closed, phase: 'weekend', minutes_to_open: 1850 }).text,
    ).toBe('🔴 ปิดสุดสัปดาห์ · เปิดอีก 30:50');
    expect(
      marketBadge({ ...closed, phase: 'daily_break', minutes_to_open: 42 }),
    ).toMatchObject({
      className: 'badge mkt-closed',
      text: '🟡 พักรายวัน · เปิดอีก 0:42',
    });
  });
});
