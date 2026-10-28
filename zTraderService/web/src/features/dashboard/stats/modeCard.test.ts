import { describe, expect, it } from 'vitest';
import type { GoldAiAssist, GoldDecision } from '../../../api/types';
import { aiLine, decisionText, outcomeClass, outcomeIcon } from './modeCard';

describe('outcomeClass / outcomeIcon', () => {
  it.each([
    ['order sent: 1234', 'ok', '🟢'],
    ['order sent after approval: abc', 'ok', '🟢'],
    ['error: cTrader not authorized', 'err', '🔴'],
    ['awaiting review (id x)', 'wait', '🟡'],
    ['NO_TRADE: no setup', 'no', '⚪'],
  ] as const)('%s', (o, cls, icon) => {
    expect(outcomeClass(o)).toBe(cls);
    expect(outcomeIcon(o)).toBe(icon);
  });

  it('nothing yet → "no"', () => {
    expect(outcomeClass(null)).toBe('no');
  });
});

const decision: GoldDecision = {
  order_type: 'BUY_LIMIT',
  entry: 4364.091,
  sl: 4357.86,
  tp1: 4375,
  tp2: null,
  rr_tp1: 1.75,
  confidence: 7,
  size: 'full',
  valid_until_utc: null,
  invalidation: '',
  playbook_ref: 'swing #1',
  reason: '',
  analysis_summary_th: '',
};

describe('decisionText', () => {
  it('formats prices with the instrument digits', () => {
    expect(decisionText(decision, 2)).toBe(
      'BUY_LIMIT @ 4364.09 · SL 4357.86 · TP1 4375.00 · RR 1.75 · conf 7',
    );
  });

  it('is empty for NO_TRADE or no decision', () => {
    expect(decisionText({ ...decision, order_type: 'NO_TRADE' }, 2)).toBe('');
    expect(decisionText(null, 2)).toBe('');
  });
});

const assist: GoldAiAssist = {
  verdict: 'ADJUST',
  entry: 4362.5,
  sl: 4355,
  tp1: 4380,
  tp2: 4390,
  size: 'half',
  confidence: 6,
  key_levels: '',
  risk_note_th: 'ข่าว CPI',
  reason_th: 'ก'.repeat(130),
  invalidation_th: 'หลุด 4350',
};

describe('aiLine', () => {
  it('cuts the reason at 120 characters and puts the full story in the tooltip', () => {
    const l = aiLine(assist, 2);
    expect(l.className).toBe('mc-ai adjust');
    expect(l.text).toBe('🤖 ADJUST ✏️ · conf 6 · ' + 'ก'.repeat(120) + '…');
    expect(l.title.split('\n')).toEqual([
      'ก'.repeat(130),
      'ความเสี่ยง: ข่าว CPI',
      'ยกเลิกเมื่อ: หลุด 4350',
      'entry 4362.50 · SL 4355.00 · TP1 4380.00 · TP2 4390.00 · size half',
    ]);
  });

  it('a VETO shows no levels', () => {
    const l = aiLine({ ...assist, verdict: 'VETO', reason_th: 'สวนเทรนด์' }, 2);
    expect(l.text).toBe('🤖 VETO 🛑 · conf 6 · สวนเทรนด์');
    expect(l.title).not.toContain('entry');
  });
});
