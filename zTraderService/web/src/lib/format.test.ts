import { describe, expect, it } from 'vitest';
import {
  fmtBytes,
  fmtHM,
  fmtP,
  fmtPx,
  money,
  signClass,
  truncate,
} from './format';
import { closedShort } from './time';

describe('fmtP (price with instrument digits)', () => {
  it.each([
    [4364.091, 2, '4364.09'],
    [1.091234, 5, '1.09123'],
    [149.5, 3, '149.500'],
    ['4364.1', 2, '4364.10'],
  ] as const)('%s @%i → %s', (v, d, out) => {
    expect(fmtP(v, d)).toBe(out);
  });

  it('keeps the original fallbacks: null → "—", non-numeric text as-is', () => {
    expect(fmtP(null, 2)).toBe('—');
    expect(fmtP(undefined, 2)).toBe('—');
    expect(fmtP('', 2)).toBe('');
    expect(fmtP('market', 2)).toBe('market');
    expect(fmtP(Number.NaN, 2)).toBe('NaN');
  });
});

describe('fmtPx (history/positions)', () => {
  it('shows "—" for anything that is not a number', () => {
    expect(fmtPx(null, 5)).toBe('—');
    expect(fmtPx(undefined, 5)).toBe('—');
    expect(fmtPx(Number.NaN, 5)).toBe('—');
    expect(fmtPx(1.0912, 5)).toBe('1.09120');
  });
});

describe('money / signClass', () => {
  it('signs non-negative values with "+"', () => {
    expect(money(12.3)).toBe('+12.30');
    expect(money(0)).toBe('+0.00');
    expect(money(-4)).toBe('-4.00');
    expect(signClass(0)).toBe('pos');
    expect(signClass(-0.01)).toBe('neg');
  });
});

describe('fmtHM (market countdown)', () => {
  it.each([
    [425, '7:05'],
    [59, '0:59'],
    [60, '1:00'],
    [0, '0:00'],
    [null, '0:00'],
    [undefined, '0:00'],
  ])('%s min → %s', (m, out) => {
    expect(fmtHM(m)).toBe(out);
  });
});

describe('small text helpers', () => {
  it('truncate adds an ellipsis only when longer', () => {
    expect(truncate('abcdef', 4)).toBe('abcd…');
    expect(truncate('abcd', 4)).toBe('abcd');
  });

  it('closedShort slices the ISO string like the original', () => {
    expect(closedShort('2026-10-28T14:05:09.000Z')).toBe('10-28 14:05');
  });

  it('fmtBytes', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
  });
});
