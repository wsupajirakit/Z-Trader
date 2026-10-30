/**
 * TradingView chart websocket wire format: a port of the parts of tvDatafeed this service needs.
 * Pure functions only (no sockets, no timers), so the framing and parsing are unit-testable.
 *
 * Every websocket frame carries one or more packets `~m~<len>~m~<payload>`. A payload is either a
 * heartbeat `~h~<n>` (echo it back verbatim) or JSON: `{"m": method, "p": params}` for session
 * traffic, or a bare object (the server hello) without `m`.
 */

const HEADER = '~m~';
const HEARTBEAT_PREFIX = '~h~';

/** chart intervals TradingView understands (minutes as a string, or 1D) */
export type TvInterval = '1' | '5' | '15' | '30' | '60' | '240' | '1D';
export const TV_INTERVALS: readonly TvInterval[] = ['1', '5', '15', '30', '60', '240', '1D'];

/** one OHLCV bar; time is unix seconds (UTC) of the bar open */
export interface TvBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/** wrap one payload (string or JSON-serialisable value) in a `~m~len~m~` packet */
export function encodeFrame(payload: unknown): string {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return `${HEADER}${body.length}${HEADER}${body}`;
}

/** a framed `{"m": method, "p": params}` session message */
export function encodeMessage(method: string, params: unknown[]): string {
    return encodeFrame({ m: method, p: params });
}

/**
 * Split one websocket frame into its packet payloads. The declared length is trusted when it lands
 * on the next header (or the end); otherwise the payload runs to the next header, so one bad length
 * does not swallow the rest of the frame.
 */
export function decodeFrames(raw: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < raw.length) {
        if (!raw.startsWith(HEADER, i)) {
            const next = raw.indexOf(HEADER, i);
            if (next < 0) break;
            i = next;
            continue;
        }
        const lenEnd = raw.indexOf(HEADER, i + HEADER.length);
        if (lenEnd < 0) break;
        const len = Number(raw.slice(i + HEADER.length, lenEnd));
        const start = lenEnd + HEADER.length;
        if (!Number.isInteger(len) || len < 0) {
            i = start;
            continue;
        }
        let end = start + len;
        if (end > raw.length || (end < raw.length && !raw.startsWith(HEADER, end))) {
            const next = raw.indexOf(HEADER, start);
            end = next < 0 ? raw.length : next;
        }
        out.push(raw.slice(start, end));
        i = end;
    }
    return out;
}

export function isHeartbeat(payload: string): boolean {
    return payload.startsWith(HEARTBEAT_PREFIX);
}

export type TvPacket =
    | { kind: 'heartbeat'; raw: string }
    | { kind: 'message'; method: string; params: unknown[] }
    | { kind: 'hello'; data: Record<string, unknown> }
    | { kind: 'invalid'; raw: string };

export function parsePacket(payload: string): TvPacket {
    if (isHeartbeat(payload)) return { kind: 'heartbeat', raw: payload };
    let data: unknown;
    try {
        data = JSON.parse(payload);
    } catch {
        return { kind: 'invalid', raw: payload };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'invalid', raw: payload };
    const o = data as Record<string, unknown>;
    if (typeof o.m === 'string') return { kind: 'message', method: o.m, params: Array.isArray(o.p) ? o.p : [] };
    return { kind: 'hello', data: o };
}

/** methods that end a chart session for good (bad symbol, bad series, broken session) */
export const TV_FATAL_METHODS = new Set(['symbol_error', 'series_error', 'critical_error', 'protocol_error']);

/** human-readable reason of an error message, e.g. "symbol_error: invalid symbol" */
export function describeError(method: string, params: unknown[]): string {
    const detail = params
        .slice(1)
        // drop our own session/series ids, keep TradingView's text
        .filter((x): x is string => typeof x === 'string' && !/^(symbol_\d+|s\d+|[cq]s_[a-z0-9]+)$/.test(x))
        .join(' ')
        .slice(0, 200);
    return detail ? `${method}: ${detail}` : method;
}

const finite = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
};

/** one `{i, v:[time, o, h, l, c, vol?]}` entry → bar, or null when it is not a usable bar */
export function toBar(entry: unknown): TvBar | null {
    const v = (entry as { v?: unknown } | null)?.v;
    if (!Array.isArray(v) || v.length < 5) return null;
    const [time, open, high, low, close] = v.slice(0, 5).map(finite);
    if (time === null || open === null || high === null || low === null || close === null) return null;
    if (time <= 0 || high <= 0 || low <= 0) return null;
    // some feeds (FOREXCOM, SAXO) send no volume at all
    const volume = finite(v[5]) ?? 0;
    return { time: Math.round(time), open, high, low, close, volume };
}

/**
 * Bars of one series inside a `timescale_update` or `du` message: `p[1][seriesId].s`.
 * Returned in ascending time order, one bar per time (the later entry wins).
 */
export function extractSeriesBars(params: unknown[], seriesId: string): TvBar[] {
    const body = params[1] as Record<string, unknown> | undefined;
    const series = body?.[seriesId] as { s?: unknown } | undefined;
    if (!series || !Array.isArray(series.s)) return [];
    const byTime = new Map<number, TvBar>();
    for (const e of series.s) {
        const b = toBar(e);
        if (b) byTime.set(b.time, b);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** `={"symbol":"OANDA:XAUUSD","adjustment":"splits"}`, the resolve_symbol argument */
export function symbolSpec(fullSymbol: string): string {
    return '=' + JSON.stringify({ symbol: fullSymbol, adjustment: 'splits' });
}

/** session ids look like tvDatafeed's: prefix + 12 random lowercase letters */
export function sessionId(prefix: 'cs' | 'qs', random: () => number = Math.random): string {
    let s = '';
    for (let i = 0; i < 12; i++) s += String.fromCharCode(97 + Math.floor(random() * 26));
    return `${prefix}_${s}`;
}

/** the messages that open one chart series, in order */
export function seriesSetupMessages(
    authToken: string | null,
    chartSession: string,
    fullSymbol: string,
    interval: TvInterval,
    nBars: number,
): string[] {
    return [
        encodeMessage('set_auth_token', [authToken ?? 'unauthorized_user_token']),
        encodeMessage('chart_create_session', [chartSession, '']),
        encodeMessage('resolve_symbol', [chartSession, 'symbol_1', symbolSpec(fullSymbol)]),
        encodeMessage('create_series', [chartSession, 's1', 's1', 'symbol_1', interval, nBars]),
        encodeMessage('switch_timezone', [chartSession, 'Etc/UTC']),
    ];
}

/** `EXCHANGE:SYMBOL` with both parts limited to the characters TradingView tickers use */
export function isValidFullSymbol(s: string): boolean {
    return /^[A-Z0-9_]{1,30}:[A-Z0-9_.!]{1,30}$/.test(s);
}
