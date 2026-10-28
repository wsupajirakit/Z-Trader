/** Number / text formatters ported from public/index.html (behaviour kept identical). */

/**
 * `fmtP` — a price with the instrument's decimals (gold 2 · EURUSD 5 · USDJPY 3).
 * Non-numeric values come back as-is; null/undefined become "—".
 */
export function fmtP(
  v: number | string | null | undefined,
  digits: number,
): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (v === '' || !Number.isFinite(n)) return String(v);
  return n.toFixed(digits);
}

/** `fmtPx` — like `fmtP` but anything that is not a number (incl. NaN) is "—". */
export function fmtPx(v: number | null | undefined, digits: number): string {
  return v === null || v === undefined || Number.isNaN(v)
    ? '—'
    : v.toFixed(digits);
}

/** Signed money with two decimals: `+12.30`, `-4.00`, `+0.00`. */
export function money(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

/** "pos" for ≥ 0, "neg" otherwise (table/summary colouring). */
export function signClass(v: number): 'pos' | 'neg' {
  return v >= 0 ? 'pos' : 'neg';
}

/** Minutes → "h:mm" (market badge countdown). Missing values count as 0. */
export function fmtHM(minutes: number | null | undefined): string {
  const total = minutes ?? 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Cut to `max` characters and add "…" when longer. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** `1234.5` → "1,234.5" (en-US grouping, as the original used for units/lot). */
export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Bytes → "12.3 KB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
