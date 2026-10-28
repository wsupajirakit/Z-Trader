import type { GoldAiAssist, GoldDecision } from '../../../api/types';
import { fmtP, truncate } from '../../../lib/format';

export type OutcomeClass = 'ok' | 'err' | 'wait' | 'no';

/** Colour of a round's outcome line, from how the server phrases it. */
export function outcomeClass(o: string | null | undefined): OutcomeClass {
  if (!o) return 'no';
  if (o.startsWith('order sent')) return 'ok';
  if (o.startsWith('error')) return 'err';
  if (o.startsWith('awaiting')) return 'wait';
  return 'no';
}

/** Archive list icon for an outcome. */
export function outcomeIcon(o: string): string {
  if (o.startsWith('order sent')) return '🟢';
  if (o.startsWith('error')) return '🔴';
  if (o.startsWith('awaiting')) return '🟡';
  return '⚪';
}

/** "BUY_LIMIT @ 4364.09 · SL 4357.86 · TP1 … · RR 1.8 · conf 7", empty for NO_TRADE. */
export function decisionText(
  dec: GoldDecision | null | undefined,
  digits: number,
): string {
  if (!dec || dec.order_type === 'NO_TRADE') return '';
  return (
    dec.order_type +
    ' @ ' +
    fmtP(dec.entry, digits) +
    ' · SL ' +
    fmtP(dec.sl, digits) +
    ' · TP1 ' +
    fmtP(dec.tp1, digits) +
    ' · RR ' +
    String(dec.rr_tp1) +
    ' · conf ' +
    dec.confidence
  );
}

const VERDICT_LABEL: Partial<Record<string, string>> = {
  CONFIRM: 'CONFIRM ✅',
  ADJUST: 'ADJUST ✏️',
  VETO: 'VETO 🛑',
};

/** Short AI line on a mode card (verdict + conf + reason cut to 120), full text as tooltip. */
export function aiLine(
  ai: GoldAiAssist,
  digits: number,
): { className: string; text: string; title: string } {
  const v = ai.verdict.toUpperCase();
  const label = VERDICT_LABEL[v] ?? (v || '?');
  const reason = ai.reason_th;
  const short = truncate(reason, 120);
  const levels =
    v !== 'VETO' && ai.entry !== null
      ? 'entry ' +
        fmtP(ai.entry, digits) +
        ' · SL ' +
        fmtP(ai.sl, digits) +
        ' · TP1 ' +
        fmtP(ai.tp1, digits) +
        (ai.tp2 !== null ? ' · TP2 ' + fmtP(ai.tp2, digits) : '') +
        ' · size ' +
        ai.size
      : '';
  const title = [
    reason,
    ai.risk_note_th && 'ความเสี่ยง: ' + ai.risk_note_th,
    ai.news_risk_th && 'ข่าว: ' + ai.news_risk_th,
    ai.invalidation_th && 'ยกเลิกเมื่อ: ' + ai.invalidation_th,
    levels,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    className: 'mc-ai ' + v.toLowerCase(),
    text:
      '🤖 ' + label + ' · conf ' + ai.confidence + (short ? ' · ' + short : ''),
    title,
  };
}
