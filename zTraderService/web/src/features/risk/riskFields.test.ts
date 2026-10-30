import { describe, expect, it } from 'vitest';
import type { BotSettings } from '../../api/types';
import { changedFields, validateRange } from './riskFields';

const s = {
  risk_usd_per_trade: 100,
  daily_max_loss_usd: 400,
  max_open_positions: 4,
  max_open_positions_total: 0,
  min_confidence: 7,
  scalp_max_per_day: 8,
  loss_cooldown_bars: 3,
  max_lot: 0.5,
  max_lot_by_instrument: { XAUUSD: 0.5, EURUSD: 2, GBPUSD: 2, USDJPY: 2 },
} as unknown as BotSettings;

describe('risk fields', () => {
  it('validates the server ranges', () => {
    expect(validateRange(5, { min: 1, max: 10 })).toBeUndefined();
    expect(validateRange(0, { min: 1, max: 10 })).toBe('1–10');
    expect(validateRange('', { min: 1, max: 10 })).toBe('Enter a number');
  });
  it('sends only what changed', () => {
    expect(
      changedFields(
        {
          risk_usd_per_trade: 100,
          daily_max_loss_usd: 500,
          max_lot_xauusd: 0.5,
        },
        s,
      ),
    ).toEqual({ daily_max_loss_usd: 500 });
  });
});
