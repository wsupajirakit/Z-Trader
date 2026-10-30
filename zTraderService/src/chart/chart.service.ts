import {
    BadGatewayException,
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    OnModuleDestroy,
    ServiceUnavailableException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../common/utils/errors';
import { CtraderService } from '../ctrader/ctrader.service';
import { INSTRUMENTS } from '../gold/domain/instruments';
import { GoldInstrumentService } from '../gold/gold-instrument.service';
import { TradingViewClient, TvFetchError } from '../integrations/tradingview/tv-client';
import {
    CTRADER_SOURCE,
    type ChartSymbol,
    type ChartTimeframe,
    TF_CTRADER_PERIOD,
    TF_SECONDS,
    TF_TV_INTERVAL,
    chartSources,
    isSourceFor,
    tvFullSymbol,
} from './chart.constants';
import { type ChartBar, type ChartListener, CtraderFeed, type LiveFeed, TvFeed } from './chart-feeds';

/** /bars answers are reused this long per (symbol, source, tf), to keep TradingView calls rare */
const BARS_CACHE_MS = 5_000;
/** an upstream feed stays open this long after its last viewer left (a page reload reuses it) */
const FEED_IDLE_MS = 60_000;

const PRICE_DIVISOR = 100_000; // cTrader Open API prices are ints × 1e5
const DAY_MS = 86_400_000;
/**
 * Widest window one ProtoOAGetTrendbarsReq asks for, per timeframe (cTrader caps the range per
 * period). Older bars are paged in further windows; a refused window is halved and retried.
 */
const CTRADER_WINDOW_MS: Record<ChartTimeframe, number> = {
    M1: 3.5 * DAY_MS,
    M5: 3.5 * DAY_MS,
    M15: 35 * 7 * DAY_MS,
    M30: 35 * 7 * DAY_MS,
    H1: 35 * 7 * DAY_MS,
    H4: 366 * DAY_MS,
    D1: 366 * DAY_MS,
};
const CTRADER_MAX_PAGES = 12;

const num = (v: any): number => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));

interface CacheEntry {
    at: number;
    limit: number;
    promise: Promise<ChartBar[]>;
}

/**
 * Candles for the dashboard chart from the account's cTrader broker or from TradingView, as one-shot
 * history (/bars, briefly cached) and as a live stream (one shared upstream feed per
 * symbol/source/tf, ref-counted by viewers).
 */
@Injectable()
export class ChartService implements OnModuleDestroy {
    private readonly logger = new Logger(ChartService.name);
    private readonly cache = new Map<string, CacheEntry>();
    private readonly feeds = new Map<string, LiveFeed>();

    constructor(
        private readonly ctrader: CtraderService,
        private readonly instruments: GoldInstrumentService,
        private readonly tv: TradingViewClient,
    ) {}

    sources(symbol: ChartSymbol) {
        return { symbol, sources: chartSources(symbol) };
    }

    /** 400 when the source is not offered for this symbol (e.g. tv:VANTAGE for EURUSD) */
    assertSource(symbol: ChartSymbol, source: string): void {
        if (!isSourceFor(symbol, source)) {
            throw new BadRequestException(`source "${source}" is not available for ${symbol} (see /api/chart/sources)`);
        }
    }

    async bars(symbol: ChartSymbol, source: string, tf: ChartTimeframe, limit: number) {
        this.assertSource(symbol, source);
        const key = `${symbol}|${source}|${tf}`;
        const now = Date.now();
        let hit = this.cache.get(key);
        if (!hit || now - hit.at > BARS_CACHE_MS || hit.limit < limit) {
            const entry: CacheEntry = { at: now, limit, promise: this.load(symbol, source, tf, limit) };
            this.cache.set(key, entry);
            // a failure is not cached: the next request tries again
            entry.promise.catch(() => {
                if (this.cache.get(key) === entry) this.cache.delete(key);
            });
            hit = entry;
        }
        const bars = await hit.promise;
        return { symbol, source, tf, bars: bars.slice(-limit) };
    }

    /**
     * Join the live feed of (symbol, source, tf); the listener gets the current status and bar at
     * once, then every change. Returns the function that leaves.
     */
    subscribe(symbol: ChartSymbol, source: string, tf: ChartTimeframe, listener: ChartListener): () => void {
        this.assertSource(symbol, source);
        const key = `${symbol}|${source}|${tf}`;
        let feed = this.feeds.get(key);
        if (!feed) {
            feed = this.createFeed(key, symbol, source, tf);
            this.feeds.set(key, feed);
            feed.start();
        }
        if (feed.idleTimer) {
            clearTimeout(feed.idleTimer);
            feed.idleTimer = null;
        }
        feed.add(listener);
        const f = feed;
        let left = false;
        return () => {
            if (left) return;
            left = true;
            f.remove(listener);
            if (f.viewers > 0 || f.idleTimer) return;
            f.idleTimer = setTimeout(() => {
                f.idleTimer = null;
                if (f.viewers > 0) return;
                f.stop();
                if (this.feeds.get(key) === f) this.feeds.delete(key);
            }, FEED_IDLE_MS);
            f.idleTimer.unref();
        };
    }

    /** open upstream feeds and their viewer counts (diagnostics and tests) */
    feedStats(): Array<{ key: string; viewers: number; state: string }> {
        return [...this.feeds.values()].map((f) => ({ key: f.key, viewers: f.viewers, state: f.status.state }));
    }

    @OnEvent('ctrader.spot')
    onSpot(e: unknown): void {
        for (const f of this.feeds.values()) if (f instanceof CtraderFeed) f.onSpot(e);
    }

    onModuleDestroy(): void {
        for (const f of this.feeds.values()) f.stop();
        this.feeds.clear();
        this.cache.clear();
    }

    // ---------------- upstream ----------------

    private createFeed(key: string, symbol: ChartSymbol, source: string, tf: ChartTimeframe): LiveFeed {
        const full = tvFullSymbol(symbol, source);
        if (full) return new TvFeed(key, this.logger, this.tv, full, TF_TV_INTERVAL[tf]);
        const profile = INSTRUMENTS[symbol];
        const owner = `chart:${symbol}:${tf}`;
        return new CtraderFeed(
            key,
            this.logger,
            {
                isAuthorized: () => this.ctrader.isAuthorized,
                symbolId: () => this.instruments.resolveSymbolId(profile),
                recentBars: (count) => this.ctraderBars(symbol, tf, count),
                subscribeSpots: async (id) => {
                    try {
                        await this.ctrader.subscribeSpots(id, owner);
                    } catch (e) {
                        // another module already subscribed this symbol on the shared session: spots
                        // flow anyway, and our owner entry is registered so they will not cut us off
                        if (!/ALREADY_SUBSCRIBED/i.test(`${(e as any)?.errorCode ?? ''} ${errorMessage(e)}`)) throw e;
                    }
                },
                unsubscribeSpots: async (id) => {
                    await this.ctrader.unsubscribeSpots(id, owner);
                },
                stillSubscribed: (id) => this.ctrader.isSpotSharedWith(id),
            },
            TF_SECONDS[tf],
            profile.digits,
        );
    }

    private async load(symbol: ChartSymbol, source: string, tf: ChartTimeframe, limit: number): Promise<ChartBar[]> {
        if (source === CTRADER_SOURCE) return this.ctraderBars(symbol, tf, limit);
        const full = tvFullSymbol(symbol, source)!;
        try {
            return await this.tv.fetchBars(full, TF_TV_INTERVAL[tf], limit);
        } catch (e) {
            if (e instanceof HttpException) throw e;
            const reason = errorMessage(e);
            this.logger.warn(`TradingView bars ${full} ${tf} failed: ${reason}`);
            throw new BadGatewayException(
                e instanceof TvFetchError && e.fatal
                    ? `TradingView has no data for ${full} (${reason})`
                    : `TradingView did not return data for ${full} (${reason})`,
            );
        }
    }

    /** newest `count` trendbars from the account broker, oldest first */
    private async ctraderBars(symbol: ChartSymbol, tf: ChartTimeframe, count: number): Promise<ChartBar[]> {
        if (!this.ctrader.isAuthorized) throw new ServiceUnavailableException('cTrader is not connected');
        const profile = INSTRUMENTS[symbol];
        let symbolId: number;
        try {
            symbolId = await this.instruments.resolveSymbolId(profile);
        } catch (e) {
            throw new BadGatewayException(`cTrader symbol lookup failed for ${symbol}: ${errorMessage(e)}`);
        }

        const byTime = new Map<number, ChartBar>();
        let window = CTRADER_WINDOW_MS[tf];
        let to = Date.now();
        let emptyPages = 0;
        for (let page = 0; page < CTRADER_MAX_PAGES && byTime.size < count; page++) {
            const from = Math.max(0, to - window);
            let res: any;
            try {
                res = await this.ctrader.request<any>(
                    'ProtoOAGetTrendbarsReq',
                    {
                        ctidTraderAccountId: this.ctrader.activeAccountId,
                        fromTimestamp: from,
                        toTimestamp: to,
                        period: TF_CTRADER_PERIOD[tf],
                        symbolId,
                        count: count - byTime.size,
                    },
                    30_000,
                );
            } catch (e) {
                // a range the broker refuses: try a narrower one before giving up
                if (
                    window > TF_SECONDS[tf] * 1000 * 50 &&
                    !/timed out|disconnect|not connected/i.test(errorMessage(e))
                ) {
                    window = Math.floor(window / 2);
                    page--;
                    continue;
                }
                if (byTime.size) break; // keep what we have
                throw new BadGatewayException(`cTrader trendbar request failed: ${errorMessage(e)}`);
            }
            const raw = (res?.trendbar ?? []) as any[];
            for (const b of raw) {
                const low = num(b.low);
                const bar: ChartBar = {
                    time: num(b.utcTimestampInMinutes) * 60,
                    open: this.round((low + num(b.deltaOpen)) / PRICE_DIVISOR, profile.digits),
                    high: this.round((low + num(b.deltaHigh)) / PRICE_DIVISOR, profile.digits),
                    low: this.round(low / PRICE_DIVISOR, profile.digits),
                    close: this.round((low + num(b.deltaClose)) / PRICE_DIVISOR, profile.digits),
                    volume: num(b.volume),
                };
                if (bar.time > 0 && bar.low > 0 && bar.high > 0) byTime.set(bar.time, bar);
            }
            // two empty windows in a row: no older history (or a long market closure we will not page over)
            emptyPages = raw.length ? 0 : emptyPages + 1;
            if (emptyPages >= 2 || from === 0) break;
            to = from;
        }
        return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-count);
    }

    private round(v: number, digits: number): number {
        return Number(v.toFixed(digits));
    }
}
