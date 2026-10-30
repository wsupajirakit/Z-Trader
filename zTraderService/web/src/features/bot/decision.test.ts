import { describe, expect, it } from 'vitest';
import type { GoldAiAssist, GoldDecision } from '../../api/types';
import { aiLine, decisionText, outcomeTone, summaryOf } from './decision';

const dec: GoldDecision = {
  order_type: 'BUY_LIMIT',
  entry: 4364.091,
  sl: 4357.86,
  tp1: 4380.1,
  tp2: null,
  rr_tp1: 1.8,
  confidence: 7,
  size: 'full',
  valid_until_utc: null,
  invalidation: '',
  playbook_ref: 'P1',
  reason: 'setup',
  analysis_summary: 'summary',
};

describe('decision helpers', () => {
  it('outcome tone follows the server phrasing', () => {
    expect(outcomeTone('order sent: 123')).toBe('ok');
    expect(outcomeTone('error: x')).toBe('err');
    expect(outcomeTone('awaiting review')).toBe('wait');
    expect(outcomeTone('no-trade: flat')).toBe('no');
    expect(outcomeTone(null)).toBe('no');
  });
  it('decision text uses instrument digits; NO_TRADE is empty', () => {
    expect(decisionText(dec, 2)).toBe(
      'BUY_LIMIT @ 4364.09 · SL 4357.86 · TP1 4380.10 · RR 1.8 · conf 7',
    );
    expect(decisionText({ ...dec, order_type: 'NO_TRADE' }, 2)).toBe('');
  });
  it('AI line reads the English field and falls back to the old *_th names', () => {
    const ai: GoldAiAssist = {
      verdict: 'VETO',
      entry: null,
      sl: null,
      tp1: null,
      tp2: null,
      size: 'quarter',
      confidence: 3,
      key_levels: '',
      reason: 'news risk',
      risk_note: 'CPI',
    };
    const l = aiLine(ai, 2);
    expect(l.text).toBe('AI VETO · conf 3 · news risk');
    expect(l.detail).toContain('Risk: CPI');
    const old = aiLine({ ...ai, reason: undefined, reason_th: 'legacy' }, 2);
    expect(old.text).toContain('legacy');
    expect(
      summaryOf({
        ...dec,
        analysis_summary: undefined,
        analysis_summary_th: 'old',
      }),
    ).toBe('old');
  });
});
