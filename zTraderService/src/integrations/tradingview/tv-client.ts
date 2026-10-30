import { EventEmitter } from 'node:events';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { errorMessage } from '../../common/utils/errors';
import { TV_BROWSER_UA, TvAuth } from './tv-auth';
import {
    TV_FATAL_METHODS,
    TV_INTERVALS,
    type TvBar,
    type TvInterval,
    decodeFrames,
    describeError,
    encodeFrame,
    extractSeriesBars,
    isValidFullSymbol,
    parsePacket,
    seriesSetupMessages,
    sessionId,
} from './tv-protocol';
import { TvThrottle } from './tv-throttle';

const WS_URL = 'wss://data.tradingview.com/socket.io/websocket';
/** tried in order; TradingView has rejected one or the other at times */
const ORIGINS = ['https://data.tradingview.com', 'https://www.tradingview.com'];
const CONNECT_TIMEOUT_MS = 10_000;
/** TradingView heartbeats every ~10-30 s; silence for this long means the socket is dead */
const INACTIVITY_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const MIN_SESSION_SPACING_MS = 750;
const FAILURES_BEFORE_COOLDOWN = 3;
const COOLDOWN_MS = 30_000;

function rawText(data: WebSocket.RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    return Buffer.from(new Uint8Array(data)).toString('utf8');
}

/** why a series ended; fatal = retrying the same request will not help (bad symbol/series) */
export interface TvSeriesEnd {
    reason: string;
    fatal: boolean;
}

export interface TvSeriesEvents {
    /** the initial bars (once per connection) */
    history: [bars: TvBar[]];
    /** a live update of the forming bar, or a new bar */
    bar: [bar: TvBar];
    /** the upstream session is over (not emitted after close()) */
    end: [end: TvSeriesEnd];
}

interface SeriesDeps {
    throttle: TvThrottle;
    auth: TvAuth;
    logger: Logger;
}

/**
 * One websocket + one chart session + one series. Starts connecting as soon as it is created
 * (after its throttle slot), emits `history` once, then `bar` for every update, and `end` exactly
 * once when the upstream goes away. close() tears it down silently.
 */
export class TvSeries extends EventEmitter<TvSeriesEvents> {
    private ws: WebSocket | null = null;
    private closed = false;
    private ended = false;
    private gotHistory = false;
    private token: string | null = null;
    private inactivity: NodeJS.Timeout | null = null;
    private readonly chartSession = sessionId('cs');

    constructor(
        readonly fullSymbol: string,
        readonly interval: TvInterval,
        readonly nBars: number,
        private readonly deps: SeriesDeps,
    ) {
        super();
        void this.start();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.teardown();
        this.removeAllListeners();
    }

    private async start(): Promise<void> {
        try {
            await this.deps.throttle.waitTurn();
            if (this.closed) return;
            this.token = await this.deps.auth.token();
            if (this.closed) return;
            this.connect(0);
        } catch (e) {
            this.finish(`connect failed: ${errorMessage(e)}`, false);
        }
    }

    private connect(originIdx: number): void {
        const ws = new WebSocket(WS_URL, {
            headers: { Origin: ORIGINS[originIdx], 'User-Agent': TV_BROWSER_UA },
            handshakeTimeout: CONNECT_TIMEOUT_MS,
        });
        this.ws = ws;
        let opened = false;

        ws.on('unexpected-response', (_req, res) => {
            ws.removeAllListeners();
            ws.on('error', () => undefined);
            ws.terminate();
            if (this.closed) return;
            if (originIdx + 1 < ORIGINS.length) {
                this.deps.logger.warn(
                    `TradingView rejected origin ${ORIGINS[originIdx]} (HTTP ${res.statusCode}); trying ${ORIGINS[originIdx + 1]}`,
                );
                this.connect(originIdx + 1);
            } else {
                this.finish(`handshake rejected (HTTP ${res.statusCode})`, false);
            }
        });
        ws.on('open', () => {
            opened = true;
            this.bumpInactivity();
            for (const m of seriesSetupMessages(
                this.token,
                this.chartSession,
                this.fullSymbol,
                this.interval,
                this.nBars,
            )) {
                ws.send(m);
            }
        });
        ws.on('message', (data: WebSocket.RawData) => {
            this.bumpInactivity();
            const raw = rawText(data);
            for (const payload of decodeFrames(raw)) this.onPacket(payload);
        });
        ws.on('error', (e) => {
            if (!opened) this.finish(`connect failed: ${errorMessage(e)}`, false);
        });
        ws.on('close', (code) => {
            this.finish(`connection closed (${code})`, false);
        });
    }

    private onPacket(payload: string): void {
        const pkt = parsePacket(payload);
        if (pkt.kind === 'heartbeat') {
            this.ws?.send(encodeFrame(pkt.raw));
            return;
        }
        if (pkt.kind !== 'message') return;
        const { method, params } = pkt;
        if (TV_FATAL_METHODS.has(method)) {
            const reason = describeError(method, params);
            // a refused token shows up as a session-level error before any data arrives
            const tokenRefused = !this.gotHistory && !!this.token && !method.startsWith('symbol_');
            if (tokenRefused) this.deps.auth.reject(this.token!);
            this.finish(reason, (method === 'symbol_error' || method === 'series_error') && !tokenRefused);
            return;
        }
        if (method !== 'timescale_update' && method !== 'du') return;
        const bars = extractSeriesBars(params, 's1');
        if (!bars.length) return;
        if (!this.gotHistory && method === 'timescale_update') {
            this.gotHistory = true;
            this.emit('history', bars);
            return;
        }
        if (!this.gotHistory) return;
        for (const b of bars) this.emit('bar', b);
    }

    private bumpInactivity(): void {
        if (this.inactivity) clearTimeout(this.inactivity);
        this.inactivity = setTimeout(() => this.finish('no data or heartbeat for 60 s', false), INACTIVITY_MS);
        this.inactivity.unref();
    }

    private finish(reason: string, fatal: boolean): void {
        if (this.ended || this.closed) return;
        this.ended = true;
        this.teardown();
        this.emit('end', { reason, fatal });
    }

    private teardown(): void {
        if (this.inactivity) clearTimeout(this.inactivity);
        this.inactivity = null;
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            ws.removeAllListeners();
            ws.on('error', () => undefined);
            try {
                ws.terminate();
            } catch {
                /* already gone */
            }
        }
    }
}

export class TvFetchError extends Error {
    constructor(
        message: string,
        readonly fatal: boolean,
    ) {
        super(message);
        this.name = 'TvFetchError';
    }
}

/**
 * TradingView chart data over its public websocket (port of tvDatafeed). Every fetch or live
 * subscription gets its own socket, and new sockets are spaced globally (TvThrottle) so bursts do not
 * trip TradingView's connection limit. Auth: see TvAuth (TV_USERNAME/TV_PASSWORD, TV_AUTH_TOKEN, or
 * anonymous).
 */
@Injectable()
export class TradingViewClient implements OnModuleDestroy {
    private readonly logger = new Logger(TradingViewClient.name);
    private readonly throttle = new TvThrottle(MIN_SESSION_SPACING_MS);
    private readonly auth: TvAuth;
    private readonly live = new Set<TvSeries>();
    private failures = 0;

    constructor(config: ConfigService) {
        this.auth = new TvAuth(() => ({
            username: config.get<string>('TV_USERNAME') || undefined,
            password: config.get<string>('TV_PASSWORD') || undefined,
            authToken: config.get<string>('TV_AUTH_TOKEN') || undefined,
        }));
    }

    get authMode(): 'login' | 'token' | 'anonymous' {
        return this.auth.mode;
    }

    /**
     * Open a live series. The caller must listen for `end` and call close() when done; the series
     * never reconnects by itself.
     */
    subscribe(fullSymbol: string, interval: TvInterval, nBars = 2): TvSeries {
        this.check(fullSymbol, interval, nBars);
        const s = new TvSeries(fullSymbol, interval, nBars, {
            throttle: this.throttle,
            auth: this.auth,
            logger: this.logger,
        });
        this.live.add(s);
        const forget = () => this.live.delete(s);
        s.once('end', forget);
        const close = s.close.bind(s);
        s.close = () => {
            forget();
            close();
        };
        return s;
    }

    /** last `nBars` bars of a symbol, oldest first; one retry on a transient failure */
    async fetchBars(
        fullSymbol: string,
        interval: TvInterval,
        nBars: number,
        timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    ): Promise<TvBar[]> {
        this.check(fullSymbol, interval, nBars);
        let last: TvFetchError | null = null;
        for (const attempt of [1, 2]) {
            try {
                const bars = await this.fetchOnce(fullSymbol, interval, nBars, timeoutMs);
                this.failures = 0;
                return bars;
            } catch (e) {
                last = e instanceof TvFetchError ? e : new TvFetchError(errorMessage(e), false);
                if (last.fatal) throw last;
                this.noteFailure();
                if (attempt === 1) {
                    this.logger.warn(
                        `TradingView ${fullSymbol} ${interval} attempt 1 failed (${last.message}); retrying`,
                    );
                    await new Promise((r) => setTimeout(r, 2_000).unref());
                }
            }
        }
        throw last!;
    }

    onModuleDestroy(): void {
        for (const s of [...this.live]) s.close();
        this.live.clear();
    }

    private fetchOnce(fullSymbol: string, interval: TvInterval, nBars: number, timeoutMs: number): Promise<TvBar[]> {
        return new Promise<TvBar[]>((resolve, reject) => {
            const s = this.subscribe(fullSymbol, interval, nBars);
            // the throttle wait is not part of the timeout: only time spent talking to TradingView counts
            const timer = setTimeout(
                () => {
                    s.close();
                    reject(new TvFetchError(`timed out after ${Math.round(timeoutMs / 1000)} s`, false));
                },
                timeoutMs + this.throttle.cooldownLeftMs() + MIN_SESSION_SPACING_MS * this.live.size,
            );
            timer.unref();
            s.once('history', (bars) => {
                clearTimeout(timer);
                s.close();
                resolve(bars);
            });
            s.once('end', (end) => {
                clearTimeout(timer);
                reject(new TvFetchError(end.reason, end.fatal));
            });
        });
    }

    private noteFailure(): void {
        if (++this.failures < FAILURES_BEFORE_COOLDOWN) return;
        this.failures = 0;
        this.throttle.tripCooldown(COOLDOWN_MS);
        this.logger.warn(`Repeated TradingView failures; pausing new sessions for ${COOLDOWN_MS / 1000} s`);
    }

    private check(fullSymbol: string, interval: TvInterval, nBars: number): void {
        if (!isValidFullSymbol(fullSymbol)) throw new TvFetchError(`invalid TradingView symbol "${fullSymbol}"`, true);
        if (!TV_INTERVALS.includes(interval))
            throw new TvFetchError(`invalid TradingView interval "${interval}"`, true);
        if (!Number.isInteger(nBars) || nBars < 1 || nBars > 5000)
            throw new TvFetchError(`invalid bar count ${nBars}`, true);
    }
}
