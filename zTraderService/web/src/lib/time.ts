/** Time helpers. Thai locale, browser time zone — as the original dashboard. */

/** Current local time for log lines, e.g. "14:05:09". */
export function nowTimeTh(now: Date = new Date()): string {
  return now.toLocaleTimeString('th-TH');
}

/** ISO timestamp → local "HH:mm:ss" (mode-card "last run"). */
export function timeTh(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH');
}

/** ISO timestamp → local "HH:mm" (daily-stop reset note). */
export function hourMinuteTh(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ISO timestamp → local date + time for admin tables; "—" for null. */
export function dateTimeTh(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('th-TH');
}

/**
 * `closed_utc` → "MM-DD HH:mm" (history table) — a string slice of the ISO value, in UTC,
 * exactly like the original.
 */
export function closedShort(iso: string): string {
  return iso.slice(5, 16).replace('T', ' ');
}
