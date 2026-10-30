import { Logger } from '@nestjs/common';
import { errorMessage } from '../common/utils/errors';
import type { TvSeries, TvSeriesEnd } from '../integrations/tradingview/tv-client';
import type { TvInterval } from '../integrations/tradingview/tv-protocol';

/** one candle as the chart API returns it; time = unix seconds (UTC) of the bar open */
export interface ChartBar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface ChartStatus {
    state: 'live' | 'reconnecting' | 'error';
    message?: string;
}

export type ChartStreamEvent = { event: 'bar'; data: ChartBar } | { event: 'status'; data: ChartStatus };
export type ChartListener = (e: ChartStreamEvent) => void;

/** bar updates are coalesced to at most one per this many ms per feed */
const BAR_FLUSH_MS = 250;

/**
 * One upstream subscription for a (symbol, source, tf), shared by every viewer. Remembers the latest
 * status and bar so a viewer who joins late gets both immediately.
 */
export abstract class LiveFeed {
    private readonly listeners = new Set<ChartListener>();
    private pending: ChartBar | null = null;
    private flushTimer: NodeJS.Timeout | null = null;
    protected stopped = false;
    lastBar: ChartBar | null = null;
    status: ChartStatus = { state: 'reconnecting', message: 'Connecting' };
    /** managed by ChartService: closes the feed a while after its last viewer left */
    idleTimer: NodeJS.Timeout | null = null;

    constructor(
        readonly key: string,
        protected readonly logger: Logger,
    ) {}

    get viewers(): number {
        return this.listeners.size;
    }

    add(l: ChartListener): void {
        this.listeners.add(l);
        l({ event: 'status', data: this.status });
        if (this.lastBar) l({ event: 'bar', data: this.lastBar });
    }

    remove(l: ChartListener): void {
        this.listeners.delete(l);
    }

    abstract start(): void;
    protected abstract onStop(): void;

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.flushTimer = this.idleTimer = null;
        this.listeners.clear();
        this.onStop();
    }

    protected setStatus(state: ChartStatus['state'], message?: string): void {
        if (this.status.state === state && this.status.message === message) return;
        this.status = message ? { state, message } : { state };
        this.broadcast({ event: 'status', data: this.status });
    }

    /** queue a bar update; a bar for a newer time flushes the previous one first so no close is lost */
    protected pushBar(bar: ChartBar, immediate = false): void {
        if (this.stopped) return;
        if (this.pending && this.pending.time !== bar.time) this.flush();
        this.pending = { ...bar };
        if (immediate) {
            this.flush();
            return;
        }
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), BAR_FLUSH_MS);
            this.flushTimer.unref();
        }
    }

    private flush(): void {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        const bar = this.pending;
        this.pending = null;
        if (!bar) return;
        if (this.lastBar && bar.time < this.lastBar.time) return; // out of order
        this.lastBar = bar;
        this.broadcast({ event: 'bar', data: bar });
    }

    private broadcast(e: ChartStreamEvent): void {
        for (const l of [...this.listeners]) {
            try {
                l(e);
            } catch (err) {
                this.logger.warn(`chart listener failed: ${errorMessage(err)}`);
            }
        }
    }
}

export interface TvFeedClient {
    subscribe(fullSymbol: string, interval: TvInterval, nBars?: number): TvSeries;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** a symbol/series TradingView refused: retry rarely, it is not going to change soon */
const FATAL_RETRY_MS = 60_000;

/** TradingView: a live series of 2 bars, reopened with exponential backoff whenever it ends */
export class TvFeed extends LiveFeed {
    private series: TvSeries | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private attempt = 0;

    constructor(
        key: string,
        logger: Logger,
        private readonly client: TvFeedClient,
        private readonly fullSymbol: string,
        private readonly interval: TvInterval,
    ) {
        super(key, logger);
    }

    start(): void {
        this.open();
    }

    private open(): void {
        if (this.stopped) return;
        let s: TvSeries;
        try {
            s = this.client.subscribe(this.fullSymbol, this.interval, 2);
        } catch (e) {
            this.retry({ reason: errorMessage(e), fatal: true });
            return;
        }
        this.series = s;
        s.on('history', (bars) => {
            this.attempt = 0;
            this.setStatus('live');
            const last = bars[bars.length - 1];
            if (last) this.pushBar(last, true);
        });
        s.on('bar', (bar) => this.pushBar(bar));
        s.on('end', (end) => {
            this.series = null;
            this.retry(end);
        });
    }

    private retry(end: TvSeriesEnd): void {
        if (this.stopped) return;
        const delay = end.fatal ? FATAL_RETRY_MS : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt);
        this.attempt++;
        const secs = Math.round(delay / 1000);
        this.logger.warn(
            `TradingView stream ${this.fullSymbol} ${this.interval} ended (${end.reason}); retry in ${secs} s`,
        );
        this.setStatus(end.fatal ? 'error' : 'reconnecting', `TradingView: ${end.reason}; retrying in ${secs} s`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.open();
        }, delay);
        this.retryTimer.unref();
    }

    protected onStop(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.series?.close();
        this.series = null;
    }
}

/** what CtraderFeed needs from the cTrader side (ChartService provides it) */
export interface CtraderFeedDeps {
    isAuthorized(): boolean;
    symbolId(): Promise<number>;
    /** the newest `count` trendbars, oldest first */
    recentBars(count: number): Promise<ChartBar[]>;
    subscribeSpots(symbolId: number): Promise<void>;
    unsubscribeSpots(symbolId: number): Promise<void>;
    /** is our spot subscription still registered (cTrader forgets them all on reconnect) */
    stillSubscribed(symbolId: number): boolean;
}

const WATCHDOG_MS = 5_000;
/** no spot for this long while "live" = resubscribe (a forced unsubscribe elsewhere, a silent drop) */
const SPOT_STALE_MS = 120_000;
const num = (v: any): number => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));

/**
 * cTrader: seeds the forming bar from the newest trendbars, then rolls it forward from spot events
 * (bid). Bar boundaries are aligned on the newest trendbar's open time, so they match the broker's
 * own bars (D1 may open at a broker-specific hour). A watchdog notices cTrader dropping and
 * resubscribes once it is back.
 */
export class CtraderFeed extends LiveFeed {
    private watchdog: NodeJS.Timeout | null = null;
    private busy = false;
    private subscribedId: number | null = null;
    private anchor: number | null = null;
    private current: ChartBar | null = null;
    private lastSpotAt = 0;

    constructor(
        key: string,
        logger: Logger,
        private readonly deps: CtraderFeedDeps,
        private readonly tfSeconds: number,
        private readonly digits: number,
    ) {
        super(key, logger);
    }

    start(): void {
        void this.ensure();
        this.watchdog = setInterval(() => void this.ensure(), WATCHDOG_MS);
        this.watchdog.unref();
    }

    /** called by ChartService for every ctrader.spot event */
    onSpot(e: any): void {
        if (this.stopped || this.subscribedId === null || this.anchor === null) return;
        if (num(e?.symbolId) !== this.subscribedId) return;
        const bid = num(e?.bid) / 100_000; // absent bid decodes as 0: an ask-only update
        if (!(bid > 0)) return;
        this.lastSpotAt = Date.now();
        const t = Math.floor((num(e?.timestamp) || Date.now()) / 1000);
        const bucket = this.anchor + Math.floor((t - this.anchor) / this.tfSeconds) * this.tfSeconds;
        const cur = this.current;
        const p = this.round(bid);
        if (!cur || bucket > cur.time) {
            this.current = { time: bucket, open: p, high: p, low: p, close: p, volume: 1 };
        } else if (bucket === cur.time) {
            this.current = {
                ...cur,
                high: Math.max(cur.high, p),
                low: Math.min(cur.low, p),
                close: p,
                volume: cur.volume + 1,
            };
        } else {
            return;
        }
        if (this.status.state !== 'live') this.setStatus('live');
        this.pushBar(this.current);
    }

    private async ensure(): Promise<void> {
        if (this.busy || this.stopped) return;
        if (!this.deps.isAuthorized()) {
            this.subscribedId = null;
            this.setStatus('reconnecting', 'cTrader is not connected');
            return;
        }
        if (
            this.subscribedId !== null &&
            this.deps.stillSubscribed(this.subscribedId) &&
            Date.now() - this.lastSpotAt < SPOT_STALE_MS
        ) {
            return;
        }
        this.busy = true;
        try {
            const id = await this.deps.symbolId();
            const bars = await this.deps.recentBars(3);
            const last = bars[bars.length - 1];
            if (last) {
                this.anchor = last.time;
                if (!this.current || last.time >= this.current.time) this.current = { ...last };
            } else if (this.anchor === null) {
                // no history at all: align on the epoch (right for intraday, close enough for D1)
                this.anchor = 0;
            }
            await this.deps.subscribeSpots(id);
            if (this.stopped) {
                await this.deps.unsubscribeSpots(id).catch(() => undefined);
                return;
            }
            this.subscribedId = id;
            this.lastSpotAt = Date.now();
            this.setStatus('live');
            if (this.current) this.pushBar(this.current, true);
        } catch (e) {
            this.subscribedId = null;
            this.setStatus('reconnecting', `cTrader: ${errorMessage(e)}`);
        } finally {
            this.busy = false;
        }
    }

    private round(v: number): number {
        return Number(v.toFixed(this.digits));
    }

    protected onStop(): void {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        const id = this.subscribedId;
        this.subscribedId = null;
        if (id !== null && this.deps.isAuthorized()) {
            this.deps
                .unsubscribeSpots(id)
                .catch((e) => this.logger.warn(`unsubscribe spots ${id}: ${errorMessage(e)}`));
        }
    }
}
