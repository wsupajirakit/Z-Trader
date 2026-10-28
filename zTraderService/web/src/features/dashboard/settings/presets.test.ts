import { describe, expect, it } from 'vitest';
import { settings } from '../../../test/fixtures';
import { matchPreset, PRESETS, tinyPresetWarning } from './presets';
import {
  applyPresetToDraft,
  draftFromSettings,
  draftToUpdate,
  EMPTY_DRAFT,
} from './riskForm';

const preset = (n: number) => {
  const p = PRESETS.find((x) => x.n === n);
  if (!p) throw new Error(`no preset ${n}`);
  return p;
};

describe('risk presets', () => {
  it('follow the formula: daily = risk × 4, 4 open, scalp 8, conf 7 (#1–#4)', () => {
    for (const n of [1, 2, 3, 4]) {
      const p = preset(n);
      expect(p.daily).toBe(p.risk * 4);
      expect([p.maxpos, p.scalp, p.conf]).toEqual([4, 8, 7]);
      expect(p.maxpos * p.risk).toBeLessThanOrEqual(p.daily);
    }
    expect(PRESETS.map((p) => p.risk)).toEqual([100, 250, 500, 1000, 10, 10]);
  });

  it('matchPreset recognises the live values, compared on the six preset fields', () => {
    expect(matchPreset(settings())).toBe(1);
    expect(
      matchPreset(
        settings({
          risk_usd_per_trade: 1000,
          daily_max_loss_usd: 4000,
          max_lot: 4,
        }),
      ),
    ).toBe(4);
    expect(matchPreset(settings({ min_confidence: 8 }))).toBeNull();
    // FX lots / totals / AI cap are not part of a preset
    expect(
      matchPreset(
        settings({ max_open_positions_total: 9, ai_max_calls_per_day: 0 }),
      ),
    ).toBe(1);
  });

  it('warns for the tiny accounts with the original numbers', () => {
    expect(tinyPresetWarning(preset(2))).toBeNull();
    expect(tinyPresetWarning(preset(5))).toBe(
      '⚠ ชุด #5 (ทุน $50) — lot 0.01 เสี่ยงจริง ~$9.6/ไม้ = 19% ของทุน ต่อไม้ · แพ้ 2 ไม้ติดกันชน daily stop · เปิดเฉพาะ scalp เท่านั้น (โหมดอื่น SL กว้างเกินงบ จะถูกปัดตกเอง)',
    );
    expect(tinyPresetWarning(preset(6))).toContain(
      '= 10% ของทุน ต่อไม้ · แพ้ 3 ไม้ติดกัน',
    );
  });
});

describe('risk form', () => {
  it('fills from settings and keeps an FX lot the server did not report', () => {
    const prev = { ...EMPTY_DRAFT, max_lot_gbpusd: '1.5' };
    const d = draftFromSettings(
      settings({ max_lot_by_instrument: { XAUUSD: 0.5, EURUSD: 2 } }),
      prev,
    );
    expect(d.risk_usd_per_trade).toBe('100');
    expect(d.max_lot_eurusd).toBe('2');
    expect(d.max_lot_gbpusd).toBe('1.5');
    expect(d.max_lot_usdjpy).toBe('');
  });

  it('a preset overwrites only its six fields', () => {
    const base = draftFromSettings(settings(), EMPTY_DRAFT);
    const d = applyPresetToDraft(
      { ...base, ai_max_calls_per_day: '50' },
      preset(4),
    );
    expect(d).toMatchObject({
      risk_usd_per_trade: '1000',
      daily_max_loss_usd: '4000',
      max_open_positions: '4',
      scalp_max_per_day: '8',
      min_confidence: '7',
      max_lot: '4',
      ai_max_calls_per_day: '50',
      max_lot_eurusd: '2',
    });
  });

  it('sends numbers and leaves blank inputs out', () => {
    const d = {
      ...EMPTY_DRAFT,
      risk_usd_per_trade: '250',
      max_lot: '0.01',
      min_confidence: ' 0 ',
    };
    expect(draftToUpdate(d)).toEqual({
      risk_usd_per_trade: 250,
      max_lot: 0.01,
      min_confidence: 0,
    });
  });
});
