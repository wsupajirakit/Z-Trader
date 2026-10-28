import type {
  BotStatus,
  InstrumentInfo,
  InstrumentListItem,
} from '../../../api/types';
import { fmtInt } from '../../../lib/format';

/** The instrument the page shows; INST_DEFAULT mirrors the original's gold fallback. */
export interface ActiveInstrument {
  key: string;
  name_th: string;
  emoji: string;
  kind: InstrumentInfo['kind'];
  digits: number;
  pip: number;
}

export const INST_DEFAULT: ActiveInstrument = {
  key: 'XAUUSD',
  name_th: 'ทองคำ',
  emoji: '🥇',
  kind: 'metal',
  digits: 2,
  pip: 0.1,
};

/** `setInst` of the original: take what the server sent, fall back to gold field by field. */
export function normalizeInstrument(
  i: Partial<InstrumentInfo> | null | undefined,
): ActiveInstrument {
  if (!i) return INST_DEFAULT;
  const digits = Number(i.digits);
  const pip = Number(i.pip);
  return {
    key: i.key || INST_DEFAULT.key,
    name_th: i.name_th || INST_DEFAULT.name_th,
    emoji: i.emoji || INST_DEFAULT.emoji,
    kind: i.kind ?? INST_DEFAULT.kind,
    digits:
      Number.isInteger(digits) && digits >= 0 ? digits : INST_DEFAULT.digits,
    pip: pip > 0 ? pip : INST_DEFAULT.pip,
  };
}

/**
 * Decimals for a trade's own symbol, not the selected one — EURUSD needs 5 places or the
 * history shows 1.09/1.09. Selected → its digits · known → its digits · unknown → 5 ·
 * no symbol (older server = gold) → the selected instrument's digits.
 */
export function digitsFor(
  symbol: string | null | undefined,
  active: ActiveInstrument,
  list: readonly InstrumentListItem[],
): number {
  if (!symbol || symbol === active.key) return active.digits;
  const known = list.find((i) => i.key === symbol);
  return known && Number.isInteger(known.digits) ? known.digits : 5;
}

/** Select option text: "🥇 XAUUSD · ทองคำ · <daily range>". */
export function instrumentOptionLabel(
  i: Partial<InstrumentListItem> & { key: string },
): string {
  return (
    (i.emoji ?? '') +
    ' ' +
    i.key +
    ' · ' +
    (i.name_th ?? '') +
    (i.daily_range_th ? ' · ' + i.daily_range_th : '')
  );
}

/** Hint under the instrument select. */
export function instrumentHint(
  active: ActiveInstrument,
  list: readonly InstrumentListItem[],
): string {
  const full = list.find((x) => x.key === active.key);
  if (!full) return active.name_th + ' · ทศนิยม ' + active.digits;
  return (
    (full.kind === 'fx' ? 'คู่เงิน' : 'โลหะ') +
    ' · ทศนิยม ' +
    full.digits +
    ' · pip ' +
    full.pip +
    ' · ' +
    fmtInt(full.units_per_lot || 0) +
    ' หน่วย/lot' +
    (full.daily_range_th ? ' · ' + full.daily_range_th : '') +
    (full.symbol_id ? ' · symbolId ' + full.symbol_id : '')
  );
}

/** Tooltip of the header instrument badge. */
export function instrumentBadgeTitle(active: ActiveInstrument): string {
  return active.name_th + ' · ทศนิยม ' + active.digits + ' · pip ' + active.pip;
}

/** Modes the viewed instrument has switched off, for the permanent warning under the select. */
export function blockedModesWarning(
  status: Pick<BotStatus, 'instrument' | 'blocked_modes' | 'tradable_modes'>,
  fallbackKey: string,
): { key: string; blocked: string[]; tradable: string[] } | null {
  const key = status.instrument.key || fallbackKey;
  const blocked = status.blocked_modes[key] ?? [];
  if (!blocked.length) return null;
  return { key, blocked, tradable: status.tradable_modes[key] ?? [] };
}
