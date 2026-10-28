/**
 * Loop checkboxes (modes and instruments) mirror the server — the original fixed a bug where
 * two tabs showed different selections and neither matched what the bot ran.
 *
 *   loop running  → the server is the truth: mirror it and lock the boxes
 *                   (a change would do nothing until the next Start)
 *   loop stopped  → the user may pick freely; until they touch a box, seed it from the server
 */
export interface LoopSelection {
  values: readonly string[];
  /** The user changed a box since the last Start/Stop. */
  dirty: boolean;
}

export const UNTOUCHED: LoopSelection = { values: [], dirty: false };

/**
 * What the boxes show. `server` is undefined until the first status arrives; until then an
 * untouched group shows `defaults` (swing / the active instrument, as the original seeded).
 */
export function shownValues(
  sel: LoopSelection,
  running: boolean,
  server: readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] {
  if (server && (running || !sel.dirty)) return server;
  return sel.dirty ? sel.values : defaults;
}

/** A click on a box (only possible while the loop is stopped). */
export function toggleValue(
  shown: readonly string[],
  value: string,
  checked: boolean,
): LoopSelection {
  const values = checked
    ? shown.includes(value)
      ? shown
      : [...shown, value]
    : shown.filter((v) => v !== value);
  return { values, dirty: true };
}

/** Checked values in display order (the original read them from the DOM). */
export function checkedInOrder(
  options: readonly string[],
  shown: readonly string[],
): string[] {
  return options.filter((o) => shown.includes(o));
}

export function boxTitle(
  running: boolean,
  checked: boolean,
  kind: 'mode' | 'instrument',
): string {
  if (!running) return '';
  if (!checked) return 'ไม่ได้เปิดในรอบนี้ — กด Stop ก่อนถ้าจะเพิ่ม';
  return kind === 'mode'
    ? 'โหมดนี้กำลังรันอยู่ — กด Stop ก่อนถ้าจะเปลี่ยน'
    : 'ตราสารนี้กำลังรันอยู่ — กด Stop ก่อนถ้าจะเปลี่ยน';
}
