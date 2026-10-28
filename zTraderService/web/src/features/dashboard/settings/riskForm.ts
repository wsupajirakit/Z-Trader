import type { BotSettings, RiskSettingsUpdate } from '../../../api/types';
import type { InfoKey } from '../info/infoContent';
import type { RiskPreset } from './presets';

/** The risk inputs, in the original grid order. Values are kept as typed (strings). */
export const RISK_FIELDS = [
  {
    name: 'risk_usd_per_trade',
    label: 'เสี่ยงต่อไม้ ($)',
    info: 'risk',
    step: 10,
    min: 1,
  },
  {
    name: 'daily_max_loss_usd',
    label: 'ขาดทุนสูงสุด/วัน ($)',
    info: 'daily',
    step: 50,
    min: 0,
  },
  {
    name: 'max_open_positions',
    label: 'ไม้ค้างพร้อมกัน',
    info: 'maxpos',
    step: 1,
    min: 1,
    max: 20,
  },
  {
    name: 'max_open_positions_total',
    label: 'ไม้ค้างรวมทุกตราสาร',
    info: 'maxpostotal',
    step: 1,
    min: 0,
    max: 200,
  },
  {
    name: 'scalp_max_per_day',
    label: 'scalp สูงสุด/วัน',
    info: 'scalp',
    step: 1,
    min: 1,
    max: 50,
  },
  {
    name: 'min_confidence',
    label: 'confidence ขั้นต่ำ',
    info: 'conf',
    step: 1,
    min: 0,
    max: 10,
  },
  {
    name: 'max_lot',
    label: 'lot สูงสุด 🥇 XAUUSD',
    info: 'maxlot',
    step: 0.01,
    min: 0.01,
  },
  {
    name: 'max_lot_eurusd',
    label: 'lot สูงสุด 🇪🇺 EURUSD',
    step: 0.01,
    min: 0.01,
  },
  {
    name: 'max_lot_gbpusd',
    label: 'lot สูงสุด 🇬🇧 GBPUSD',
    step: 0.01,
    min: 0.01,
  },
  {
    name: 'max_lot_usdjpy',
    label: 'lot สูงสุด 🇯🇵 USDJPY',
    step: 0.01,
    min: 0.01,
  },
  {
    name: 'ai_max_calls_per_day',
    label: 'AI ยิงสูงสุด/วัน',
    info: 'aicalls',
    step: 1,
    min: 0,
    max: 10000,
  },
] as const satisfies readonly {
  name: keyof RiskSettingsUpdate;
  label: string;
  info?: InfoKey;
  step: number;
  min: number;
  max?: number;
}[];

export type RiskFieldName = (typeof RISK_FIELDS)[number]['name'];
export type RiskDraft = Record<RiskFieldName, string>;

export const EMPTY_DRAFT: RiskDraft = {
  risk_usd_per_trade: '',
  daily_max_loss_usd: '',
  max_open_positions: '',
  max_open_positions_total: '',
  scalp_max_per_day: '',
  min_confidence: '',
  max_lot: '',
  max_lot_eurusd: '',
  max_lot_gbpusd: '',
  max_lot_usdjpy: '',
  ai_max_calls_per_day: '',
};

const FX_LOT_FIELDS = [
  ['max_lot_eurusd', 'EURUSD'],
  ['max_lot_gbpusd', 'GBPUSD'],
  ['max_lot_usdjpy', 'USDJPY'],
] as const;

/** Fill the inputs from the server. A per-instrument lot the server does not report keeps its value. */
export function draftFromSettings(s: BotSettings, prev: RiskDraft): RiskDraft {
  const next: RiskDraft = {
    ...prev,
    risk_usd_per_trade: String(s.risk_usd_per_trade),
    daily_max_loss_usd: String(s.daily_max_loss_usd),
    max_open_positions: String(s.max_open_positions),
    scalp_max_per_day: String(s.scalp_max_per_day),
    min_confidence: String(s.min_confidence),
    max_lot: String(s.max_lot),
    ai_max_calls_per_day: String(s.ai_max_calls_per_day),
    max_open_positions_total: String(s.max_open_positions_total),
  };
  for (const [field, key] of FX_LOT_FIELDS) {
    const v = s.max_lot_by_instrument[key];
    if (v !== undefined) next[field] = String(v);
  }
  return next;
}

/** Overwrite the six fields a preset sets (the FX lots / totals / AI cap stay as they are). */
export function applyPresetToDraft(draft: RiskDraft, p: RiskPreset): RiskDraft {
  return {
    ...draft,
    risk_usd_per_trade: String(p.risk),
    daily_max_loss_usd: String(p.daily),
    max_open_positions: String(p.maxpos),
    scalp_max_per_day: String(p.scalp),
    min_confidence: String(p.conf),
    max_lot: String(p.maxlot),
  };
}

/**
 * Request body for `POST /settings`. Blank inputs are left out — the server always ignored
 * them — and the rest are sent as numbers; range checks stay on the server.
 */
export function draftToUpdate(draft: RiskDraft): RiskSettingsUpdate {
  const out: RiskSettingsUpdate = {};
  for (const { name } of RISK_FIELDS) {
    const raw = draft[name].trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[name] = n;
  }
  return out;
}
