import type { BotSettings, RiskSettingsUpdate } from '../../api/types';

export interface RiskField {
  key: keyof RiskSettingsUpdate;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  help: string;
  read: (s: BotSettings) => number;
}

/** the risk settings the server accepts, with its limits (GoldAutomateService.setSettings) */
export const RISK_FIELDS: readonly RiskField[] = [
  {
    key: 'risk_usd_per_trade',
    label: 'Risk per trade',
    min: 1,
    max: 100_000,
    step: 1,
    unit: 'USD',
    help: 'Loss at the stop for one trade; lot size follows from it.',
    read: (s) => s.risk_usd_per_trade,
  },
  {
    key: 'daily_max_loss_usd',
    label: 'Daily stop',
    min: 0,
    max: 1_000_000,
    step: 1,
    unit: 'USD',
    help: 'No new trades for the UTC day after losing this much (0 = off).',
    read: (s) => s.daily_max_loss_usd,
  },
  {
    key: 'max_open_positions',
    label: 'Open trades / instrument',
    min: 1,
    max: 20,
    step: 1,
    help: 'Maximum positions open at once per instrument.',
    read: (s) => s.max_open_positions,
  },
  {
    key: 'max_open_positions_total',
    label: 'Open trades total',
    min: 0,
    max: 200,
    step: 1,
    help: 'Across every instrument (0 = no extra cap).',
    read: (s) => s.max_open_positions_total,
  },
  {
    key: 'min_confidence',
    label: 'Min confidence',
    min: 0,
    max: 8,
    step: 1,
    help: 'Trades below this confidence are skipped (TA tops out at 8).',
    read: (s) => s.min_confidence,
  },
  {
    key: 'scalp_max_per_day',
    label: 'Scalps / day',
    min: 1,
    max: 50,
    step: 1,
    help: 'Daily cap for the scalp mode.',
    read: (s) => s.scalp_max_per_day,
  },
  {
    key: 'loss_cooldown_bars',
    label: 'Loss cooldown',
    min: 0,
    max: 100,
    step: 1,
    unit: 'bars',
    help: 'Bars to wait before re-entering after a losing close.',
    read: (s) => s.loss_cooldown_bars,
  },
  {
    key: 'max_lot_xauusd',
    label: 'Max lot XAUUSD',
    min: 0.01,
    max: 100,
    step: 0.01,
    unit: 'lot',
    help: 'Lot cap for gold.',
    read: (s) => s.max_lot_by_instrument.XAUUSD ?? s.max_lot,
  },
  {
    key: 'max_lot_eurusd',
    label: 'Max lot EURUSD',
    min: 0.01,
    max: 100,
    step: 0.01,
    unit: 'lot',
    help: 'Lot cap for EURUSD.',
    read: (s) => s.max_lot_by_instrument.EURUSD ?? 0,
  },
  {
    key: 'max_lot_gbpusd',
    label: 'Max lot GBPUSD',
    min: 0.01,
    max: 100,
    step: 0.01,
    unit: 'lot',
    help: 'Lot cap for GBPUSD.',
    read: (s) => s.max_lot_by_instrument.GBPUSD ?? 0,
  },
  {
    key: 'max_lot_usdjpy',
    label: 'Max lot USDJPY',
    min: 0.01,
    max: 100,
    step: 0.01,
    unit: 'lot',
    help: 'Lot cap for USDJPY.',
    read: (s) => s.max_lot_by_instrument.USDJPY ?? 0,
  },
];

export function validateRange(
  v: unknown,
  f: Pick<RiskField, 'min' | 'max'>,
): string | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (v === '' || !Number.isFinite(n)) return 'Enter a number';
  if (n < f.min || n > f.max) return `${f.min}–${f.max}`;
  return undefined;
}

/** only the fields that differ from the server */
export function changedFields(
  values: Record<string, number>,
  s: BotSettings,
): RiskSettingsUpdate {
  const out: RiskSettingsUpdate = {};
  for (const f of RISK_FIELDS) {
    const v = values[f.key];
    if (v !== undefined && v !== f.read(s)) out[f.key] = v;
  }
  return out;
}

/** human labels for the settings keys a profile resolves to */
export const SETTING_LABEL: Record<string, string> = Object.fromEntries(
  RISK_FIELDS.map((f) => [f.key, f.label]),
);
