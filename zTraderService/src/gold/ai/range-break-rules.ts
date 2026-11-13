/**
 * The Asian-range break (scalp #2 / intraday #2): what every AI prompt says about it and how the
 * code treats an AI answer on it. Evidence and the replay of the live AI answers:
 * docs/breakout-entry.md.
 *
 * Every prompt carries the block — assist (reviewer), lead / AI only (analyst) and the Claude engine
 * — at every strictness level, appended after the strictness line so it is the last word on range
 * breaks. The prompt alone is not trusted: applyAssist keeps the measured levels and drops a range
 * break only for the two hard veto reasons below, whatever the AI writes.
 */
import type { AiStrictness } from './ai-strictness';
import type { GoldSize } from './gold-ai.service';

/** "scalp #2" and "intraday #2" only — swing #2 and position #2 are pullbacks, not range breaks */
export const isRangeBreak = (playbookRef: string | null | undefined): boolean =>
    /^(scalp|intraday) #2$/.test(String(playbookRef ?? '').trim());

/** why the AI vetoed; recorded with every answer so the categories can be measured */
export const VETO_REASONS = [
    'none',
    'major_news',
    'data_error',
    'structure',
    'levels',
    'late_entry',
    'exposure',
    'companions',
    'other',
] as const;
export type VetoReason = (typeof VETO_REASONS)[number];

/** the only veto reasons that cancel a range break */
export const RANGE_BREAK_HARD_VETO: readonly VetoReason[] = ['major_news', 'data_error'];

/**
 * A range break the AI doubts (a soft veto, or confidence below the strictness or global minimum) is
 * traded smaller, never dropped: on 10–12 Nov 2026 the doubted first breaks went 5 TP / 2 SL. The
 * stricter the setting, the smaller the position.
 */
export const RANGE_BREAK_DOUBT_SIZE: Record<AiStrictness, GoldSize> = {
    normal: 'half',
    strict: 'half',
    very_strict: 'quarter',
    maximum: 'quarter',
};

const HEADER =
    '## Range breaks (scalp #2 / intraday #2) — final rules: they override the STRICTNESS line and every level rule above';

const EVIDENCE =
    'a London break that holds runs through those levels (of the first breaks vetoed for that reason on 10–12 Nov 2026, 5 of 7 reached TP1; the rule itself was measured over 60 trading days of 5-minute bars)';

/** for the AI that reviews a TA signal (assist) */
export const RANGE_BREAK_REVIEWER_RULES = [
    HEADER,
    '- Entry (a STOP with the break), SL (beyond the broken range edge) and TP1 (1.5R, or 1.5× the Asian range) come from the measured rule. The system keeps these levels whatever you answer — do not ADJUST them.',
    `- Do not VETO because TP1 crosses a round number, a figure or the previous day's high/low: ${EVIDENCE}.`,
    '- Do not call the entry late or stale: the system sends only the first break per side per day, at the bar that confirmed it.',
    '- VETO a range break only with veto_reason "major_news" (a high-impact scheduled release inside the trade\'s horizon) or "data_error" (the data contradicts itself or is obviously broken). Only these two cancel it.',
    '- Any other concern (structure, levels, exposure, companions): answer CONFIRM, name it in risk_note and lower confidence or size. For a range break that makes the position smaller — at every strictness level it does not cancel the trade.',
].join('\n');

/** for the AI that looks for its own trades (lead, AI only, the Claude engine) */
export const RANGE_BREAK_ANALYST_RULES = [
    HEADER,
    '- A range break is the first 5m (scalp) / 15m (intraday) close beyond the Asian range (23:00–07:00 UTC) during the London window — one trade per side per day.',
    '- Enter with the break: BUY_STOP / SELL_STOP just past that close. SL beyond the broken edge (1.4×ATR14 of the 5m for scalp, 1.0–1.5×ATR14 of the 1h for intraday). TP1 = 1.5R for scalp; the larger of 1.5× the Asian range and the mode minimum R:R for intraday.',
    `- Do not cut TP1 in front of a round number, a figure or the previous day's high/low, and do not reject a break for that reason: ${EVIDENCE}.`,
    '- Price already far past the edge, or a break signalled earlier today, is not a range break any more — no range-break trade then.',
].join('\n');
