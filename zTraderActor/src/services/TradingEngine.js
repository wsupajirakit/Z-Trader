import { EventEmitter } from 'node:events';
import { tradeLog } from '../logging/logger.js';
import { STRATEGY_MODES } from '../strategies/modes.js';

/**
 * The Sonic/Scalper polling loop that used to live in index.js. Behaviour is unchanged:
 * a 1 s scheduler calls tick() when `nextRun` is due (10 s in Sonic, 60 s otherwise),
 * a market-gateway connect triggers an immediate tick, and a 30 s heartbeat line is
 * logged while running.
 *
 * Events: `state` ({ isRunning, symbols, mode }) and `market` ({ symbol, price, rsi }).
 */
export class TradingEngine extends EventEmitter {
    /**
     * @param {{
     *   strategy: import('../strategies/StrategyController.js').StrategyController,
     *   marketFeed: import('./MarketFeed.js').MarketFeed,
     *   trading: { symbols: string[], mode: string, maxPositions: number },
     * }} deps
     */
    constructor({ strategy, marketFeed, trading }) {
        super();
        this.strategy = strategy;
        this.marketFeed = marketFeed;
        this.state = {
            isRunning: false,
            symbols: [...trading.symbols],
            mode: trading.mode,
            maxPositions: trading.maxPositions,
            liveStatusMap: new Map(),
        };
        this.nextRun = 0;
        this.loopInterval = null;
        this.heartbeat = null;
    }

    /** Connects the market feed and starts the heartbeat. Does not start trading. */
    init() {
        this.heartbeat = setInterval(() => {
            if (this.state.isRunning) {
                tradeLog.info('[Exec] Monitoring market conditions... (Syncing)');
            }
        }, 30000); // Every 30s to avoid too much noise but show life

        this.marketFeed.on('connect', () => {
            if (this.state.isRunning) this.tick(true);
        });
        this.marketFeed.on('indicators', (payload) => this.onIndicators(payload));
        this.marketFeed.connect();
    }

    getState() {
        return { isRunning: this.state.isRunning, symbols: this.state.symbols, mode: this.state.mode };
    }

    /**
     * Everything a polling dashboard needs in one read: the state, the limits, the valid modes and
     * the latest indicator values per configured symbol. Values that were never received are null.
     */
    getSnapshot() {
        const { state } = this;
        const orNull = (v) => {
            const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
            return typeof n === 'number' && Number.isFinite(n) ? n : null;
        };
        return {
            ...this.getState(),
            symbols: [...state.symbols],
            maxPositions: state.maxPositions,
            modes: [...STRATEGY_MODES],
            symbolsLive: state.symbols.map((symbol) => {
                const live = state.liveStatusMap.get(symbol) ?? {};
                return {
                    symbol,
                    price: orNull(live.price),
                    rsi: orNull(live.rsi),
                    ema: orNull(live.ema),
                    lastUpdate: live.lastUpdate ? new Date(live.lastUpdate).toISOString() : null,
                    hasReceived: live.hasReceived === true,
                };
            }),
        };
    }

    onIndicators(payload) {
        const { symbol, price, rsi, ema20, rsiM15, ema20M15, bid } = payload ?? {};
        if (!this.state.symbols.includes(symbol)) return;

        this.state.liveStatusMap.set(symbol, {
            hasReceived: true,
            lastUpdate: Date.now(),
            price: bid || price,
            rsi: rsi || rsiM15,
            ema: ema20 || ema20M15,
        });

        this.emit('market', { symbol, price: bid || price, rsi: rsi || rsiM15 });
    }

    async tick(triggeredByEvent = false) {
        const { state } = this;
        if (!state.isRunning) return;

        const isSonic = state.mode.toLowerCase() === 'sonic';
        const interval = isSonic ? 10000 : 60000;
        this.nextRun = Date.now() + interval;

        for (const symbol of state.symbols) {
            const data = state.liveStatusMap.get(symbol) || { hasReceived: false };
            if (isSonic && data.hasReceived && !triggeredByEvent) continue;

            try {
                await this.strategy.run(symbol, undefined, state.maxPositions);
            } catch (error) {
                tradeLog.error(`Tick Error for ${symbol}: ${error.message}`);
            }
        }
    }

    /**
     * @param {string[]} symbols validated symbol list
     * @param {string} mode      validated, normalised mode (see strategies/modes.js)
     */
    start(symbols, mode) {
        const { state } = this;
        tradeLog.info(`[Exec] Starting Trading: ${symbols.join(', ')} Mode: ${mode}`);

        state.symbols = symbols;
        state.mode = mode;
        state.isRunning = true;

        this.strategy.setMode(state.mode);
        state.symbols.forEach((s) => {
            if (!state.liveStatusMap.has(s)) {
                state.liveStatusMap.set(s, { hasReceived: false });
            }
        });

        this.emit('state', this.getState());

        if (this.loopInterval) clearInterval(this.loopInterval);
        this.loopInterval = setInterval(() => {
            if (Date.now() >= this.nextRun) this.tick();
        }, 1000);

        this.tick();
    }

    stop() {
        tradeLog.info('[Exec] Stopping Trading Loop');
        this.state.isRunning = false;
        if (this.loopInterval) clearInterval(this.loopInterval);
        this.loopInterval = null;
        this.emit('state', this.getState());
    }

    close() {
        if (this.state.isRunning) this.stop();
        clearInterval(this.heartbeat);
        this.marketFeed.close();
    }
}
