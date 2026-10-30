import { describe, expect, it } from 'vitest';
import {
  closedShort,
  fmtAge,
  fmtHM,
  fmtP,
  money,
  truncate,
  usd,
} from './format';

describe('format', () => {
  it('fmtP uses the instrument decimals and dashes missing values', () => {
    expect(fmtP(4364.091, 2)).toBe('4364.09');
    expect(fmtP(1.0912345, 5)).toBe('1.09123');
    expect(fmtP(null, 2)).toBe('—');
    expect(fmtP('n/a', 2)).toBe('n/a');
  });
  it('money is signed', () => {
    expect(money(12.3)).toBe('+12.30');
    expect(money(-4)).toBe('-4.00');
  });
  it('usd groups thousands and handles negatives', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(-20)).toBe('-$20.00');
    expect(usd(null)).toBe('—');
  });
  it('time helpers', () => {
    expect(fmtHM(125)).toBe('2:05');
    expect(fmtAge(42)).toBe('42s');
    expect(fmtAge(305)).toBe('5m 05s');
    expect(closedShort('2026-10-30T14:05:09Z')).toBe('10-30 14:05');
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
});
