/**
 * Live profit of an open position, worked out in the browser from the latest bid/ask, so showing it
 * costs no request. It matches the broker's gross P&L (checked against a real closed XAUUSD deal:
 * 0.02 lot sell 3989.68 → 3984.64 = +10.08 USD); commission and swap are booked by the broker at
 * the close and show in the trade log.
 */
export interface PnlInstrument {
  units_per_lot: number;
  quote_ccy: 'USD' | 'JPY';
  pip: number;
}

export interface PnlPosition {
  side: 'BUY' | 'SELL';
  lots: number;
  entry: number;
}

export interface Pnl {
  /** the price the position would close at now: bid for a buy, ask for a sell */
  mark: number;
  /** price distance in the position's favour (negative = against) */
  move: number;
  pips: number;
  /** gross profit in USD */
  usd: number;
}

export function livePnl(
  p: PnlPosition,
  quote: { bid: number; ask: number } | null | undefined,
  inst: PnlInstrument | null | undefined,
): Pnl | null {
  if (!quote || !inst || !(quote.bid > 0)) return null;
  const mark = p.side === 'BUY' ? quote.bid : quote.ask || quote.bid;
  const move = p.side === 'BUY' ? mark - p.entry : p.entry - mark;
  const inQuote = move * p.lots * inst.units_per_lot;
  // a JPY-quoted pair (USDJPY) earns yen; one dollar is `mark` yen
  const usd = inst.quote_ccy === 'USD' ? inQuote : inQuote / mark;
  return { mark, move, pips: move / inst.pip, usd };
}

/** "+$12.40" / "-$3.05" */
export function fmtUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "45s", "12m", "3h 05m", "2d 4h" since a timestamp */
export function fmtRunning(sinceMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
