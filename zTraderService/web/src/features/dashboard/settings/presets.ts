import type { BotSettings } from '../../../api/types';

/**
 * Recommended risk sets ("ชุดค่าแนะนำ"). Formula: risk/trade = 1% of the account ·
 * daily stop = risk × 4 · 4 open trades (open × risk ≤ daily stop) · scalp 8/day (real setups
 * are 2–5 a day) · conf 7 (passes 88% of setups) · max lot = lot at the tightest SL × 2.
 *
 * #5/#6 are tiny accounts, worked backwards from the minimum lot instead of a % of the account:
 * XAUUSD 0.01 lot moves $1 per $1, and the median scalp SL is $9.62, so a trade risks ~$9.62
 * whatever the account size. risk = $10 gives exactly 0.01 lot and lets the risk-budget guard
 * reject wide-SL modes by itself (intraday SL ~$24 → $24 > $12 budget).
 */
export interface RiskPreset {
  n: PresetNumber;
  name: string;
  risk: number;
  daily: number;
  maxpos: number;
  scalp: number;
  conf: number;
  maxlot: number;
}

export type PresetNumber = 1 | 2 | 3 | 4 | 5 | 6;

export const PRESETS: readonly RiskPreset[] = [
  {
    n: 1,
    name: 'พอร์ต $10,000',
    risk: 100,
    daily: 400,
    maxpos: 4,
    scalp: 8,
    conf: 7,
    maxlot: 0.5,
  },
  {
    n: 2,
    name: 'พอร์ต $25,000',
    risk: 250,
    daily: 1000,
    maxpos: 4,
    scalp: 8,
    conf: 7,
    maxlot: 1,
  },
  {
    n: 3,
    name: 'พอร์ต $50,000',
    risk: 500,
    daily: 2000,
    maxpos: 4,
    scalp: 8,
    conf: 7,
    maxlot: 2,
  },
  {
    n: 4,
    name: 'พอร์ต $100,000',
    risk: 1000,
    daily: 4000,
    maxpos: 4,
    scalp: 8,
    conf: 7,
    maxlot: 4,
  },
  {
    n: 5,
    name: 'ทุน $50',
    risk: 10,
    daily: 20,
    maxpos: 1,
    scalp: 3,
    conf: 8,
    maxlot: 0.01,
  },
  {
    n: 6,
    name: 'ทุน $100',
    risk: 10,
    daily: 30,
    maxpos: 1,
    scalp: 5,
    conf: 7,
    maxlot: 0.01,
  },
];

/** Button captions: `#n`, the account, the risk per trade. */
export const PRESET_BUTTONS: Record<
  PresetNumber,
  { label: string; sub: string; tiny: boolean }
> = {
  1: { label: 'พอร์ต $10K', sub: 'เสี่ยง $100/ไม้', tiny: false },
  2: { label: 'พอร์ต $25K', sub: 'เสี่ยง $250/ไม้', tiny: false },
  3: { label: 'พอร์ต $50K', sub: 'เสี่ยง $500/ไม้', tiny: false },
  4: { label: 'พอร์ต $100K', sub: 'เสี่ยง $1,000/ไม้', tiny: false },
  5: { label: 'ทุน $50', sub: 'เสี่ยง $10/ไม้ = 20% ⚠', tiny: true },
  6: { label: 'ทุน $100', sub: 'เสี่ยง $10/ไม้ = 10% ⚠', tiny: true },
};

/** Real median scalp SL in $ at 0.01 lot (57 archived setups). */
const SCALP_SL_USD = 9.62;

function fingerprint(values: readonly number[]): string {
  return values.join(',');
}

/** Which preset the live settings match exactly (risk, daily, open, scalp, conf, gold max lot). */
export function matchPreset(
  s: Pick<
    BotSettings,
    | 'risk_usd_per_trade'
    | 'daily_max_loss_usd'
    | 'max_open_positions'
    | 'scalp_max_per_day'
    | 'min_confidence'
    | 'max_lot'
  >,
): PresetNumber | null {
  const cur = fingerprint([
    s.risk_usd_per_trade,
    s.daily_max_loss_usd,
    s.max_open_positions,
    s.scalp_max_per_day,
    s.min_confidence,
    s.max_lot,
  ]);
  const hit = PRESETS.find(
    (p) =>
      fingerprint([p.risk, p.daily, p.maxpos, p.scalp, p.conf, p.maxlot]) ===
      cur,
  );
  return hit ? hit.n : null;
}

/** Extra warning logged for the tiny-account sets #5/#6; null for the others. */
export function tinyPresetWarning(p: RiskPreset): string | null {
  if (p.n < 5) return null;
  const capital = p.n === 5 ? 50 : 100;
  return (
    '⚠ ชุด #' +
    p.n +
    ' (' +
    p.name +
    ') — lot 0.01 เสี่ยงจริง ~$9.6/ไม้ = ' +
    Math.round((SCALP_SL_USD / capital) * 100) +
    '% ของทุน ต่อไม้ · แพ้ ' +
    Math.floor(p.daily / SCALP_SL_USD) +
    ' ไม้ติดกันชน daily stop · เปิดเฉพาะ scalp เท่านั้น (โหมดอื่น SL กว้างเกินงบ จะถูกปัดตกเอง)'
  );
}

/** Confidence above what TA can ever produce (8) silences the bot. */
export const TA_MAX_CONFIDENCE = 8;
