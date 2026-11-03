import { describe, expect, it } from 'vitest';
import { fmtRunning, fmtUsd, livePnl } from './pnl';

const XAU = { units_per_lot: 100, quote_ccy: 'USD' as const, pip: 0.1 };
const EUR = { units_per_lot: 100_000, quote_ccy: 'USD' as const, pip: 0.0001 };
const JPY = { units_per_lot: 100_000, quote_ccy: 'JPY' as const, pip: 0.01 };

describe('live P&L', () => {
  it('matches the broker on a real closed gold trade (+10.08 USD gross)', () => {
    const r = livePnl(
      { side: 'SELL', lots: 0.02, entry: 3989.68 },
      { bid: 3984.5, ask: 3984.64 },
      XAU,
    );
    expect(r?.mark).toBe(3984.64); // a sell closes at the ask
    expect(r?.usd).toBeCloseTo(10.08, 6);
  });

  it('a buy closes at the bid; FX pips and dollars', () => {
    const r = livePnl(
      { side: 'BUY', lots: 1.43, entry: 1.11969 },
      { bid: 1.12007, ask: 1.12009 },
      EUR,
    );
    expect(r?.mark).toBe(1.12007);
    expect(r?.pips).toBeCloseTo(3.8, 6);
    expect(r?.usd).toBeCloseTo(54.34, 6);
  });

  it('turns yen into dollars for USDJPY', () => {
    const r = livePnl(
      { side: 'BUY', lots: 1, entry: 150 },
      { bid: 151, ask: 151.02 },
      JPY,
    );
    expect(r?.usd).toBeCloseTo((1 * 100_000) / 151, 6);
  });

  it('no price or no instrument = no number (never a fake zero)', () => {
    expect(livePnl({ side: 'BUY', lots: 1, entry: 1 }, null, EUR)).toBeNull();
    expect(
      livePnl({ side: 'BUY', lots: 1, entry: 1 }, { bid: 1, ask: 1 }, null),
    ).toBeNull();
  });

  it('formats money and running time', () => {
    expect(fmtUsd(12.4)).toBe('+$12.40');
    expect(fmtUsd(-3.05)).toBe('-$3.05');
    expect(fmtUsd(1234.5)).toBe('+$1,234.50');
    const t0 = 1_000_000;
    expect(fmtRunning(t0, t0 + 45_000)).toBe('45s');
    expect(fmtRunning(t0, t0 + 12 * 60_000)).toBe('12m');
    expect(fmtRunning(t0, t0 + 185 * 60_000)).toBe('3h 05m');
    expect(fmtRunning(t0, t0 + 52 * 3_600_000)).toBe('2d 4h');
  });
});
