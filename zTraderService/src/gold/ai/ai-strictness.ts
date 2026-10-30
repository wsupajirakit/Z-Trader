/**
 * AI strictness (dashboard setting GOLD_AI_STRICTNESS). Every level is at least as strict as `normal`,
 * which is the behaviour before this setting existed: the levels only add a veto and tighten the prompt,
 * they never relax a guard that already exists.
 */
export const AI_STRICTNESS_LEVELS = ['normal', 'strict', 'very_strict', 'maximum'] as const;
export type AiStrictness = (typeof AI_STRICTNESS_LEVELS)[number];

/** the AI's own confidence (0-10) must reach this, otherwise the trade is vetoed; null = no extra veto */
export const STRICTNESS_MIN_AI_CONFIDENCE: Record<AiStrictness, number | null> = {
    normal: null,
    strict: 6,
    very_strict: 7,
    maximum: 8,
};

/** sampling temperature ceiling for models that still accept one (Gemini); the lower of this and the configured value wins */
export const STRICTNESS_MAX_TEMPERATURE: Record<AiStrictness, number> = {
    normal: Infinity,
    strict: 0.15,
    very_strict: 0.1,
    maximum: 0.05,
};

export const STRICTNESS_INSTRUCTION: Record<AiStrictness, string> = {
    normal: '',
    strict:
        'STRICTNESS: strict. Only approve or propose a trade when structure, trend and confirmation all agree. ' +
        'When in doubt, answer NO_TRADE / VETO. Report confidence honestly; below 6 means the trade will be discarded.',
    very_strict:
        'STRICTNESS: very strict. Approve or propose only textbook setups with clean structure, aligned higher ' +
        'timeframes and no nearby high-impact news. Prefer NO_TRADE / VETO in any ambiguous case. Confidence below 7 ' +
        'means the trade will be discarded.',
    maximum:
        'STRICTNESS: maximum. Capital preservation comes first. Approve or propose only exceptional setups where every ' +
        'factor agrees and the risk is clearly defined; otherwise answer NO_TRADE / VETO. Confidence below 8 means ' +
        'the trade will be discarded.',
};
