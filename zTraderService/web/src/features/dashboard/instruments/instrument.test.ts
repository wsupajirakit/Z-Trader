import { describe, expect, it } from 'vitest';
import { EUR, JPY, XAU, status } from '../../../test/fixtures';
import {
  blockedModesWarning,
  digitsFor,
  INST_DEFAULT,
  instrumentHint,
  instrumentOptionLabel,
  normalizeInstrument,
} from './instrument';

const gold = normalizeInstrument(XAU);
const list = [XAU, EUR, JPY];

describe('digitsFor — a trade uses its own instrument decimals', () => {
  it.each([
    ['XAUUSD', 2],
    ['EURUSD', 5],
    ['USDJPY', 3],
    ['GBPUSD', 5], // not in the list → 5
    [null, 2], // older server sends no symbol = the selected instrument
    ['', 2],
  ])('%s → %i', (sym, d) => {
    expect(digitsFor(sym, gold, list)).toBe(d);
  });

  it('the selected instrument wins even when the list is empty', () => {
    expect(digitsFor('EURUSD', normalizeInstrument(EUR), [])).toBe(5);
  });
});

describe('normalizeInstrument', () => {
  it('falls back to gold field by field', () => {
    expect(normalizeInstrument(null)).toEqual(INST_DEFAULT);
    expect(normalizeInstrument({ key: 'EURUSD', digits: -1, pip: 0 })).toEqual({
      ...INST_DEFAULT,
      key: 'EURUSD',
    });
    expect(
      normalizeInstrument({ key: 'USDJPY', digits: 3, pip: 0.01 }).digits,
    ).toBe(3);
  });
});

describe('labels', () => {
  it('option label and hint read like the original', () => {
    expect(instrumentOptionLabel(XAU)).toBe('🥇 XAUUSD · ทองคำ · $30–60');
    expect(instrumentHint(gold, list)).toBe(
      'โลหะ · ทศนิยม 2 · pip 0.1 · 100 หน่วย/lot · $30–60 · symbolId 41',
    );
    expect(instrumentHint(normalizeInstrument(EUR), list)).toBe(
      'คู่เงิน · ทศนิยม 5 · pip 0.0001 · 100,000 หน่วย/lot · 60–90 pip · symbolId 1',
    );
    expect(instrumentHint(gold, [])).toBe('ทองคำ · ทศนิยม 2');
  });
});

describe('blockedModesWarning', () => {
  it('is null when nothing is blocked, else lists blocked and tradable modes', () => {
    expect(blockedModesWarning(status(), 'XAUUSD')).toBeNull();
    const s = status({
      blocked_modes: { XAUUSD: ['swing', 'position'] },
      tradable_modes: { XAUUSD: ['scalp', 'intraday'] },
    });
    expect(blockedModesWarning(s, 'XAUUSD')).toEqual({
      key: 'XAUUSD',
      blocked: ['swing', 'position'],
      tradable: ['scalp', 'intraday'],
    });
  });
});
