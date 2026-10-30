import type { AiMode, AiStrictness } from '../../api/types';

export const DECISION_MODES: readonly {
  id: AiMode;
  label: string;
  detail: string;
}[] = [
  {
    id: 'off',
    label: 'TA only',
    detail:
      'Rule-based technical analysis decides alone. No AI calls, no AI cost.',
  },
  {
    id: 'assist',
    label: 'TA → AI confirm',
    detail:
      'TA finds the setup first; the AI confirms, adjusts or vetoes it. The AI can only lower risk.',
  },
  {
    id: 'lead',
    label: 'TA + AI lead',
    detail:
      'As TA → AI confirm, and when TA finds nothing the AI may propose a trade (half size max, stricter guards).',
  },
  {
    id: 'ai_only',
    label: 'AI only',
    detail:
      'The AI reads the data and proposes every trade. Every code guard (R:R, ATR, size cap, risk budget) still applies.',
  },
];

export const STRICTNESS: readonly {
  id: AiStrictness;
  label: string;
  detail: string;
}[] = [
  {
    id: 'normal',
    label: 'Normal',
    detail:
      'No extra veto — the AI may lower confidence; the global minimum confidence decides.',
  },
  {
    id: 'strict',
    label: 'Strict',
    detail:
      'Trades where the AI’s own confidence is below 6/10 are vetoed; a stricter prompt and lower temperature.',
  },
  {
    id: 'very_strict',
    label: 'Very strict',
    detail: 'AI confidence must be 7/10 or more; only textbook setups pass.',
  },
  {
    id: 'maximum',
    label: 'Maximum',
    detail: 'AI confidence must be 8/10; capital preservation first.',
  },
];

/** short label of a decision mode for chips and the status bar */
export const AI_MODE_LABEL: Record<string, string> = Object.fromEntries(
  DECISION_MODES.map((d) => [d.id, d.label]),
);
