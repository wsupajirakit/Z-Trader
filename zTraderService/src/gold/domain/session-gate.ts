/**
 * When a mode may open new trades, by New York time. scalp and intraday trade only inside their
 * session windows and never in a news blackout; swing and position trade in any session.
 *
 * `sessionGate` also finds when trading resumes, so the System log can say "no trading until
 * 21:00" instead of counting down to a round that will only be skipped.
 */
import type { GoldMode } from '../data/gold-data.service';
import type { SessionSpec } from './instruments';
import { etParts, marketStatus, type MarketHoursSpec } from './market-hours';

const MINUTE = 60_000;
const DAY_MIN = 24 * 60;
/** longest closed stretch: Friday cutoff to the Monday scalp window */
const HORIZON_MS = 4 * DAY_MIN * MINUTE;

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** why this mode may not open a trade at ET minute `min` of weekday `dow` (0 = Sunday), or null */
export function sessionBlock(mode: GoldMode, s: SessionSpec, min: number, dow: number): string | null {
    if (mode === 'swing' || mode === 'position') return null;
    for (const b of s.blackouts) {
        if (min >= b.from && min < b.to) return b.label_th;
    }
    if (s.fridayCutoff != null && dow === 5 && min >= s.fridayCutoff) {
        return 'Friday afternoon ET — no new trades before the weekly close';
    }
    if (mode === 'scalp' && !s.scalpWindows.some(([a, b]) => min >= a && min < b)) {
        return `outside the scalp window (${s.scalpWindows.map(([a, b]) => `${hhmm(a)}-${hhmm(b)} ET`).join(' / ')})`;
    }
    if (mode === 'intraday') {
        const [a, b] = s.intradayWindow;
        if (!(min >= a && min < b)) return `outside the intraday window (${hhmm(a)}–${hhmm(b)} ET)`;
    }
    return null;
}

export interface GateClosed {
    reason: string;
    /** first minute the session allows a trade and the market is open; null = not within 4 days */
    resumesAt: Date | null;
}

/** null when the mode may trade now; otherwise why not and when it may again */
export function sessionGate(
    mode: GoldMode,
    s: SessionSpec,
    hours: MarketHoursSpec,
    now: Date = new Date(),
): GateClosed | null {
    let { min, dow } = etParts(now);
    const reason = sessionBlock(mode, s, min, dow);
    if (!reason) return null;

    // walk forward a minute at a time on the ET wall clock; ask the market calendar only when
    // the session itself would allow a trade, and jump straight to its next open when it is shut
    let t = Math.floor(now.getTime() / MINUTE) * MINUTE;
    const end = t + HORIZON_MS;
    while (t < end) {
        t += MINUTE;
        if (++min === DAY_MIN) {
            min = 0;
            dow = (dow + 1) % 7;
        }
        if (sessionBlock(mode, s, min, dow)) continue;
        const mkt = marketStatus(new Date(t), hours);
        if (mkt.open) return { reason, resumesAt: new Date(t) };
        if (!mkt.next_open_utc) break;
        t = Math.max(t, Math.floor(Date.parse(mkt.next_open_utc) / MINUTE) * MINUTE - MINUTE);
        ({ min, dow } = etParts(new Date(t)));
    }
    return { reason, resumesAt: null };
}

export interface GateItem {
    inst: string;
    mode: GoldMode;
}

/** "XAUUSD scalp+intraday, USDJPY scalp" — or just "scalp+intraday" when one instrument runs */
export function joinModes(items: readonly GateItem[], multi: boolean): string {
    const by = new Map<string, GoldMode[]>();
    for (const i of items) by.set(i.inst, [...(by.get(i.inst) ?? []), i.mode]);
    return [...by].map(([inst, modes]) => (multi ? `${inst} ${modes.join('+')}` : modes.join('+'))).join(', ');
}

/** the reason without its clock times, for grouping: "news blackout", "outside the scalp window" */
export function gateKind(reason: string): string {
    return reason
        .replace(/\s*\(.*$/, '')
        .replace(/\s+\d{2}:\d{2}-\d{2}:\d{2} ET$/, '')
        .trim();
}

const clock = (tz: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const day = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' });
const BKK_CLOCK = clock('Asia/Bangkok');
const ET_CLOCK = clock('America/New_York');
const BKK_DAY = day('Asia/Bangkok');
const ET_DAY = day('America/New_York');

export function fmtIn(ms: number): string {
    const m = Math.max(0, Math.round(ms / MINUTE));
    if (m < 60) return `${m} min`;
    if (m < DAY_MIN) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
    return `${Math.floor(m / DAY_MIN)} d ${Math.floor((m % DAY_MIN) / 60)} h`;
}

/** "21:00 BKK" — with the weekday when it is not today in Bangkok */
export function fmtBkk(at: Date, now: Date): string {
    const d = BKK_DAY.format(at) === BKK_DAY.format(now) ? '' : `${BKK_DAY.format(at)} `;
    return `${d}${BKK_CLOCK.format(at)} BKK`;
}

/** "21:00 BKK / 09:00 ET (in 25 min)" */
export function fmtResume(at: Date | null, now: Date): string {
    if (!at) return 'not within the next 4 days';
    const d = ET_DAY.format(at) === ET_DAY.format(now) ? '' : `${ET_DAY.format(at)} `;
    return `${fmtBkk(at, now)} / ${d}${ET_CLOCK.format(at)} ET (in ${fmtIn(at.getTime() - now.getTime())})`;
}
