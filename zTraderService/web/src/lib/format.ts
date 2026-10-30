/** price with the instrument's decimals; null/undefined → "—" */
export function fmtP(
  v: number | string | null | undefined,
  digits: number,
): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (v === '' || !Number.isFinite(n)) return String(v);
  return n.toFixed(digits);
}

/** signed money with two decimals: +12.30 / -4.00 */
export function money(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

/** USD amount with grouping: $1,234.50 */
export function usd(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (
    (v < 0 ? '-$' : '$') +
    Math.abs(v).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

/** minutes → "h:mm" */
export function fmtHM(minutes: number | null | undefined): string {
  const total = minutes ?? 0;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** ISO → local date + time; "—" for null */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', { hour12: false });
}

/** ISO → local HH:mm:ss */
export function timeOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString('en-GB', { hour12: false });
}

/** "MM-DD HH:mm" from an ISO string, in UTC */
export function closedShort(iso: string): string {
  return iso.slice(5, 16).replace('T', ' ');
}

/** seconds → "4m 05s" / "1h 02m" */
export function fmtAge(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600)
    return `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}
