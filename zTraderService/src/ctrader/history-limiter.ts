/**
 * cTrader Open API caps historical-data requests (deal lists, trendbars) at about 5 per second per
 * application. This file holds the pieces that keep the service under that cap; CtraderService applies
 * them to every request of those types, so no caller has to think about it.
 */

/** payload types counted by cTrader's "historical data" limit */
export const HISTORY_REQUESTS: ReadonlySet<string> = new Set([
    'ProtoOAGetTrendbarsReq',
    'ProtoOAGetTickDataReq',
    'ProtoOADealListReq',
    'ProtoOADealListByPositionIdReq',
]);

/** a little under the 5/s cap, so bursts from several callers still fit */
export const HISTORY_MIN_INTERVAL_MS = 260;

export const RATE_LIMIT_RETRIES = 4;

/** true for cTrader's "too many requests" answer (ProtoOAErrorRes), whatever shape it arrives in */
export function isRateLimited(error: unknown): boolean {
    if (error === null || typeof error !== 'object') return false;
    const e = error as Record<string, unknown>;
    const text = [e.errorCode, e.description, e.message].filter((v): v is string => typeof v === 'string').join(' ');
    return /REQUEST_FREQUENCY_EXCEEDED|rate limit/i.test(text);
}

/** exponential backoff with jitter: ~0.5 s, 1 s, 2 s, 4 s (±25%), capped at 8 s */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(8_000, 500 * 2 ** attempt);
    return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * Runs tasks one start at a time, at least `minIntervalMs` apart, in call order. A task's own
 * duration does not block the next start (requests overlap on the wire), only the spacing does.
 */
export class RequestLimiter {
    private nextStart = 0;

    constructor(
        private readonly minIntervalMs: number,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    ) {}

    async schedule<T>(task: () => Promise<T>): Promise<T> {
        const start = Math.max(this.now(), this.nextStart);
        this.nextStart = start + this.minIntervalMs; // reserved synchronously, so call order is kept
        const wait = start - this.now();
        if (wait > 0) await this.sleep(wait);
        return task();
    }
}

/** retries `task` while cTrader answers "rate limited", waiting with backoff between tries */
export async function retryOnRateLimit<T>(
    task: () => Promise<T>,
    opts: {
        retries?: number;
        sleep?: (ms: number) => Promise<void>;
        random?: () => number;
        onRetry?: (attempt: number, delayMs: number) => void;
    } = {},
): Promise<T> {
    const retries = opts.retries ?? RATE_LIMIT_RETRIES;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
        try {
            return await task();
        } catch (e) {
            if (!isRateLimited(e) || attempt >= retries) throw e;
            const delay = backoffDelay(attempt, opts.random);
            opts.onRetry?.(attempt + 1, delay);
            await sleep(delay);
        }
    }
}
