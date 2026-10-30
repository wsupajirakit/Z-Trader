import type { GoldAiAssist, GoldDecision } from '../../api/types';
import { fmtP, truncate } from '../../lib/format';

export type OutcomeTone = 'ok' | 'err' | 'wait' | 'no';

/** colour of a round's outcome line, from how the server phrases it */
export function outcomeTone(o: string | null | undefined): OutcomeTone {
  if (!o) return 'no';
  if (o.startsWith('order sent')) return 'ok';
  if (o.startsWith('error')) return 'err';
  if (o.startsWith('awaiting')) return 'wait';
  return 'no';
}

/** "BUY_LIMIT @ 4364.09 · SL 4357.86 · TP1 4380.10 · RR 1.8 · conf 7"; empty for NO_TRADE */
export function decisionText(
  dec: GoldDecision | null | undefined,
  digits: number,
): string {
  if (!dec || dec.order_type === 'NO_TRADE') return '';
  return `${dec.order_type} @ ${fmtP(dec.entry, digits)} · SL ${fmtP(dec.sl, digits)} · TP1 ${fmtP(dec.tp1, digits)} · RR ${String(dec.rr_tp1)} · conf ${dec.confidence}`;
}

/** free-text reason of an AI answer, whichever field name the server used */
export function aiReason(ai: GoldAiAssist): string {
  return ai.reason ?? ai.reason_th ?? '';
}

/** short AI line for a mode card and the full detail for its tooltip */
export function aiLine(
  ai: GoldAiAssist,
  digits: number,
): { verdict: string; text: string; detail: string } {
  const verdict = (
    ai.verdict ??
    (ai.action === 'TRADE' ? 'PROPOSE' : ai.action) ??
    '?'
  ).toUpperCase();
  const reason = aiReason(ai);
  const levels =
    verdict !== 'VETO' && ai.entry !== null
      ? `entry ${fmtP(ai.entry, digits)} · SL ${fmtP(ai.sl, digits)} · TP1 ${fmtP(ai.tp1, digits)}${ai.tp2 !== null ? ` · TP2 ${fmtP(ai.tp2, digits)}` : ''} · size ${ai.size}`
      : '';
  const risk = ai.risk_note ?? ai.risk_note_th;
  const news = ai.news_risk ?? ai.news_risk_th;
  const inval = ai.invalidation ?? ai.invalidation_th;
  return {
    verdict,
    text: `AI ${verdict} · conf ${ai.confidence}${reason ? ` · ${truncate(reason, 120)}` : ''}`,
    detail: [
      reason,
      risk && `Risk: ${risk}`,
      news && `News: ${news}`,
      inval && `Invalid if: ${inval}`,
      levels,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function summaryOf(dec: GoldDecision): string {
  return dec.analysis_summary ?? dec.analysis_summary_th ?? '';
}
