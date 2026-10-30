import { Injectable, Logger } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { CtraderService } from '../ctrader/ctrader.service';
import { RSI, EMA, ATR } from 'technicalindicators';
import { errorMessage } from '../common/utils/errors';

@Injectable()
export class LiveDataService {
    private readonly logger = new Logger(LiveDataService.name);
    // Generic Trendbar Cache mapping: symbolId -> period -> Array of bars
    private multiTrendbarCache: Map<number, Map<number, any[]>> = new Map();
    private subscribedSymbols: Set<number> = new Set();
    private symbolNames: Map<number, string> = new Map();
    private symbolDigits: Map<number, number> = new Map();
    private lastCalculationTime: Map<number, number> = new Map();
    private seedingInProgress: Set<number> = new Set();
    private symbolMaxPositions: Map<number, number> = new Map();

    constructor(
        private readonly ctraderService: CtraderService,
        private readonly eventEmitter: EventEmitter2,
        private readonly configService: ConfigService,
    ) {}

    private getStrategyForSymbol(symbolId: number): string {
        const symbolName = this.getSymbolName(symbolId);
        const globalMode = (this.configService.get<string>('STRATEGY_MODE') || 'SONIC').toUpperCase();

        if (symbolName === 'XAUUSD') {
            const xauusdMode = this.configService.get<string>('XAUUSD_MODE');
            if (xauusdMode) return xauusdMode.toUpperCase();

            // If global STRATEGY_MODE is SONIC, we respect it for Gold.
            // If it's SCALPER, we use it.
            // If it's something else (default or unknown), we use SCALPER for Gold.
            if (globalMode === 'SONIC') return 'SONIC';

            return 'SCALPER'; // Default for gold
        }

        return globalMode;
    }

    private getSymbolName(symbolId: number): string {
        const cached = this.symbolNames.get(symbolId);
        if (cached) return cached;
        // Fallback for common symbols if not yet in cache
        const common: Record<number, string> = {
            41: 'XAUUSD',
            4: 'USDJPY',
            1: 'EURUSD',
            10026: 'BTCUSD',
        };
        return common[symbolId] || `Unknown(${symbolId})`;
    }

    async subscribeSymbol(symbolId: number, symbolName?: string, maxPositions: number = 1) {
        if (symbolName) this.symbolNames.set(symbolId, symbolName);
        const name = symbolName || this.getSymbolName(symbolId);
        if (this.subscribedSymbols.has(symbolId)) return;
        if (this.seedingInProgress.has(symbolId)) return;

        this.logger.log(`[act] Starting Subscription for ${name} (ID: ${symbolId})`);
        this.symbolMaxPositions.set(symbolId, maxPositions);

        try {
            this.seedingInProgress.add(symbolId);

            // 0. Fetch symbol details for digits and name
            try {
                const symbolRes = await this.ctraderService.getSymbolById(symbolId);
                if (symbolRes && symbolRes.symbol && symbolRes.symbol[0]) {
                    const sym = symbolRes.symbol[0];
                    this.symbolDigits.set(symbolId, sym.digits);
                    this.symbolNames.set(symbolId, sym.symbolName);
                    this.logger.log(`[DEBUG] Set digits for ${sym.symbolName}: ${sym.digits}`);
                }
            } catch (e) {
                this.logger.warn(`[DEBUG] Could not fetch symbol details for ${symbolId}: ${errorMessage(e)}`);
                this.symbolDigits.set(symbolId, symbolId === 41 ? 2 : 5);
            }

            // 1. Seed historical data for all required periods
            const strategy = this.getStrategyForSymbol(symbolId);
            this.logger.log(`[think] Selected Strategy: ${strategy} for ${name}`);
            let periods = [5, 7, 9, 10]; // Default HIGH_WIN_RATE
            if (strategy === 'SCALPER') periods = [5, 7, 9];
            else if (strategy === 'SONIC') periods = [5, 9];
            if (symbolId === 22396) periods.push(11); // BTCUSD D1

            for (const period of periods) {
                let seeded = false;
                for (let i = 0; i < 3; i++) {
                    seeded = await this.seedPeriodData(symbolId, period);
                    if (seeded) break;
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }

            // 2. Subscribe to real-time events based on symbol
            await this.ctraderService.subscribeSpots(symbolId, 'klines');

            if (strategy === 'SCALPER') {
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 5); // M5
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 7); // M15
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 9); // H1
            } else if (strategy === 'SONIC') {
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 5); // M5
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 9); // H1
            } else {
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 5); // M5
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 7); // M15
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 9); // H1
                await this.ctraderService.subscribeLiveTrendbar(symbolId, 10); // H4
                if (symbolId === 22396) await this.ctraderService.subscribeLiveTrendbar(symbolId, 11); // D1
            }

            this.subscribedSymbols.add(symbolId);
            this.seedingInProgress.delete(symbolId);
            this.logger.log(
                `Successfully subscribed to events for Sym=${symbolId} (${this.symbolNames.get(symbolId)})`,
            );

            // Initial calc
            this.calculateIndicators(symbolId);
        } catch (error) {
            this.seedingInProgress.delete(symbolId);
            this.logger.error(`Failed to subscribe to ${symbolId}: ${errorMessage(error)}`);
        }
    }

    private async seedPeriodData(symbolId: number, period: number): Promise<boolean> {
        const periodFactor = this.getPeriodMinutes(period);
        const toTimestamp = Date.now();
        const fromTimestamp = toTimestamp - 200 * periodFactor * 60 * 1000;

        try {
            const res = await this.ctraderService.request<any>('ProtoOAGetTrendbarsReq', {
                ctidTraderAccountId: this.ctraderService.activeAccountId,
                fromTimestamp,
                toTimestamp,
                period,
                symbolId,
            });

            if (res && res.trendbar && res.trendbar.length > 0) {
                const bars = this.reconstructBars(res.trendbar, symbolId);
                let symbolCache = this.multiTrendbarCache.get(symbolId);
                if (!symbolCache) {
                    symbolCache = new Map();
                    this.multiTrendbarCache.set(symbolId, symbolCache);
                }
                symbolCache.set(
                    period,
                    bars.filter((b) => b.close > 0),
                );
                this.logger.log(`[act] Seeded ${bars.length} bars for ${this.getSymbolName(symbolId)} P=${period}`);
                return true;
            }
            return false;
        } catch (error) {
            this.logger.error(`Failed to seed Sym=${symbolId} P=${period}: ${errorMessage(error)}`);
            return false;
        }
    }

    private getPeriodMinutes(period: number): number {
        switch (period) {
            case 5:
                return 5;
            case 6:
                return 10;
            case 7:
                return 15;
            case 8:
                return 30;
            case 9:
                return 60;
            case 10:
                return 240;
            case 11:
                return 1440;
            default:
                return 5;
        }
    }

    private reconstructBars(trendbars: any[], _symbolId: number) {
        const factor = Math.pow(10, 5); // cTrader internal factor is usually 10^5

        // However, we should check if we need to adjust based on symbol digits
        // For BTCUSD (digits 2 or 3), /100000 works for raw Proto, but we need to ensure consistency

        return trendbars.map((bar: any) => ({
            timestamp: Number(bar.utcTimestampInMinutes) * 60 * 1000,
            low: Number(bar.low) / factor,
            open: (Number(bar.low) + Number(bar.deltaOpen)) / factor,
            high: (Number(bar.low) + Number(bar.deltaHigh)) / factor,
            close: (Number(bar.low) + Number(bar.deltaClose)) / factor,
            volume: Number(bar.volume),
        }));
    }

    private calculateIndicators(symbolId: number, bid?: number, ask?: number) {
        const now = Date.now();
        const lastCalc = this.lastCalculationTime.get(symbolId) || 0;
        if (now - lastCalc < 500) return;
        this.lastCalculationTime.set(symbolId, now);

        const symbolCache = this.multiTrendbarCache.get(symbolId);
        if (!symbolCache) return;

        // Choose trigger period based on strategy
        const strategy = this.getStrategyForSymbol(symbolId);

        if (strategy === 'SCALPER') {
            // Multi-Timeframe Scan: Scan M5 and M15 for setups
            this.calculateScalper(symbolId, 5, bid, ask);
            this.calculateScalper(symbolId, 7, bid, ask);
        } else {
            const triggerPeriod = strategy === 'HIGH_WIN_RATE' ? 7 : 5;
            const mainCache = symbolCache.get(triggerPeriod);
            if (!mainCache || mainCache.length < 25) return;
            const lastPrice = bid || mainCache[mainCache.length - 1].close;

            if (strategy === 'SONIC') {
                this.calculateSonic(symbolId, lastPrice, bid, ask);
            } else {
                this.calculateHighWinRate(symbolId, lastPrice, bid, ask);
            }
        }
    }

    private calculateScalper(symbolId: number, entryPeriod: number, bid?: number, ask?: number) {
        const symbolCache = this.multiTrendbarCache.get(symbolId);
        if (!symbolCache) return;

        const entryCache = symbolCache.get(entryPeriod) || [];
        if (entryCache.length < 50) return;

        const lastBar = entryCache[entryCache.length - 1];
        const lastPrice = bid || lastBar.close;

        const closes = entryCache.map((b) => b.close);
        closes[closes.length - 1] = lastPrice;

        const rsi = RSI.calculate({ values: closes, period: 14 }).pop() || 0;
        const ema20 = EMA.calculate({ values: closes, period: 20 }).pop() || 0;
        const ema50 = EMA.calculate({ values: closes, period: 50 }).pop() || 0;

        const symbolName = this.getSymbolName(symbolId);
        this.logger.debug(
            `[DEBUG] Scalper ${symbolName} (${this.getPeriodMinutes(entryPeriod)}m): Price=${lastPrice}, RSI=${rsi}, EMA20=${ema20}`,
        );

        // 1. H1 Trend (Required for all Scalper entries)
        const h1Cache = symbolCache.get(9) || [];
        let h1TrendBuy = false,
            h1TrendSell = false,
            h1Ema50 = 0;
        if (h1Cache.length >= 50) {
            const h1Closes = h1Cache.map((b) => b.close);
            h1Closes[h1Closes.length - 1] = lastPrice;
            h1Ema50 = EMA.calculate({ values: h1Closes, period: 50 }).pop() || 0;
            h1TrendBuy = lastPrice > h1Ema50;
            h1TrendSell = lastPrice < h1Ema50;
        }

        // 2. M15 Trend (Required for all Scalper entries)
        const m15Cache = symbolCache.get(7) || [];
        let ema20M15 = 0,
            ema50M15 = 0;
        if (m15Cache.length >= 50) {
            const m15Closes = m15Cache.map((b) => b.close);
            m15Closes[m15Closes.length - 1] = lastPrice;
            ema20M15 = EMA.calculate({ values: m15Closes, period: 20 }).pop() || 0;
            ema50M15 = EMA.calculate({ values: m15Closes, period: 50 }).pop() || 0;
        }

        // ATR for Sideways Guard on entry period
        const atr = ATR.calculate({
            high: entryCache.map((b) => b.high),
            low: entryCache.map((b) => b.low),
            close: closes,
            period: 14,
        });
        const lastAtr = atr.pop() || 0;
        const atrMa20 = atr.slice(-20).reduce((a, b) => a + b, 0) / 20;

        const avgVolume = entryCache.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;

        this.eventEmitter.emit('indicators.updated', {
            symbolId,
            symbol: symbolName,
            price: lastPrice,
            bid: bid || lastPrice,
            ask: ask || lastPrice,
            rsi,
            ema20,
            ema50,
            tickVolume: entryCache[entryCache.length - 1].volume,
            avgVolume,
            ema20M15,
            ema50M15,
            h1Ema50,
            lastAtr,
            atrMa20,
            h1TrendBuy,
            h1TrendSell,
            recentBars: entryCache.slice(-3),
            strategy: 'SCALPER',
            entryPeriod: this.getPeriodMinutes(entryPeriod),
            maxPositions: this.symbolMaxPositions.get(symbolId) || 1,
        });
    }

    private calculateSonic(symbolId: number, lastPrice: number, bid?: number, ask?: number) {
        const cache = this.multiTrendbarCache.get(symbolId)?.get(5) || [];
        const closes = cache.map((b) => b.close);
        closes[closes.length - 1] = lastPrice;

        const rsi = RSI.calculate({ values: closes, period: 14 }).pop() || 0;
        const ema20 = EMA.calculate({ values: closes, period: 20 }).pop() || 0;
        const ema50 = EMA.calculate({ values: closes, period: 50 }).pop() || 0;

        const symbolName = this.getSymbolName(symbolId);
        this.logger.debug(`[DEBUG] Sonic ${symbolName}: Price=${lastPrice}, RSI=${rsi}, EMA20=${ema20}`);

        const h1Cache = this.multiTrendbarCache.get(symbolId)?.get(9) || [];
        let h1TrendBuy = false,
            h1TrendSell = false;
        if (h1Cache.length >= 50) {
            const h1Closes = h1Cache.map((b) => b.close);
            h1Closes[h1Closes.length - 1] = lastPrice;
            const h1Ema50 = EMA.calculate({ values: h1Closes, period: 50 }).pop() || 0;
            h1TrendBuy = lastPrice > h1Ema50;
            h1TrendSell = lastPrice < h1Ema50;
        }

        const avgVolume = cache.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;

        this.eventEmitter.emit('indicators.updated', {
            symbolId,
            symbol: symbolName,
            price: lastPrice,
            bid: bid || lastPrice,
            ask: ask || lastPrice,
            rsi,
            ema20,
            ema50,
            tickVolume: cache[cache.length - 1].volume,
            avgVolume,
            h1TrendBuy,
            h1TrendSell,
            recentBars: cache.slice(-3),
            strategy: 'SONIC',
            maxPositions: this.symbolMaxPositions.get(symbolId) || 1,
        });
    }

    private calculateHighWinRate(symbolId: number, lastPrice: number, bid?: number, ask?: number) {
        const symbolCache = this.multiTrendbarCache.get(symbolId);
        if (!symbolCache) return;

        const m15Cache = symbolCache.get(7) || [];
        const h1Cache = symbolCache.get(9) || [];
        const h4Cache = symbolCache.get(10) || [];

        if (m15Cache.length < 50 || h1Cache.length < 50 || h4Cache.length < 50) return;

        const m15Closes = m15Cache.map((b) => b.close);
        m15Closes[m15Closes.length - 1] = lastPrice;

        const rsiM15 = RSI.calculate({ values: m15Closes, period: 14 }).pop() || 0;
        const ema20M15 = EMA.calculate({ values: m15Closes, period: 20 }).pop() || 0;
        const ema50M15 = EMA.calculate({ values: m15Closes, period: 50 }).pop() || 0;

        const symbolName = this.getSymbolName(symbolId);
        this.logger.debug(`[DEBUG] HighWinRate ${symbolName}: Price=${lastPrice}, RSI=${rsiM15}, EMA20=${ema20M15}`);

        // ATR for Sideways Guard
        const atrM15 = ATR.calculate({
            high: m15Cache.map((b) => b.high),
            low: m15Cache.map((b) => b.low),
            close: m15Closes,
            period: 14,
        });
        const lastAtr = atrM15.pop() || 0;
        const atrMa20 = atrM15.slice(-20).reduce((a, b) => a + b, 0) / 20;

        const h1Ema50 = EMA.calculate({ values: h1Cache.map((b) => b.close), period: 50 }).pop() || 0;
        const h4Ema50 = EMA.calculate({ values: h4Cache.map((b) => b.close), period: 50 }).pop() || 0;

        let d1Ema50 = 0;
        if (symbolId === 22396) {
            const d1Cache = symbolCache.get(11) || [];
            if (d1Cache.length >= 50) {
                const d1Closes = d1Cache.map((b) => b.close);
                d1Ema50 = EMA.calculate({ values: d1Closes, period: 50 }).pop() || 0;
            }
        }

        this.eventEmitter.emit('indicators.updated', {
            symbolId,
            symbol: symbolName,
            price: lastPrice,
            bid: bid || lastPrice,
            ask: ask || lastPrice,
            rsiM15,
            ema20M15,
            ema50M15,
            h1Ema50,
            h4Ema50,
            d1Ema50,
            lastAtr,
            atrMa20,
            tickVolume: m15Cache[m15Cache.length - 1].volume,
            avgVolume: m15Cache.slice(-20).reduce((a, b) => a + b.volume, 0) / 20,
            m15Bars: m15Cache.slice(-3),
            strategy: 'HIGH_WIN_RATE',
            maxPositions: this.symbolMaxPositions.get(symbolId) || 1,
        });
    }

    getLatestBars(symbolId: number) {
        const symbolCache = this.multiTrendbarCache.get(symbolId);
        if (!symbolCache) return [];
        const strategy = this.getStrategyForSymbol(symbolId);
        const period = strategy === 'HIGH_WIN_RATE' ? 7 : 5;
        return (symbolCache.get(period) || []).slice(-100);
    }

    @OnEvent('ctrader.trendbar')
    handleTrendbarEvent(payload: any) {
        const symbolId = Number(payload.symbolId);
        const period = Number(payload.period);
        const trendbars = payload.trendbar;

        let symbolCache = this.multiTrendbarCache.get(symbolId);
        if (!symbolCache) {
            symbolCache = new Map();
            this.multiTrendbarCache.set(symbolId, symbolCache);
        }

        let cache = symbolCache.get(period);
        if (!cache) {
            if (this.seedingInProgress.has(symbolId)) return;
            cache = [];
            symbolCache.set(period, cache);
        }

        const bars = this.reconstructBars(trendbars, symbolId);
        bars.forEach((bar) => {
            const index = cache.findIndex((b) => b.timestamp === bar.timestamp);
            if (index !== -1) cache[index] = bar;
            else {
                cache.push(bar);
                if (cache.length > 200) cache.shift();
            }
        });

        if (period === 5 || period === 7) this.calculateIndicators(symbolId);
    }

    @OnEvent('ctrader.spot')
    handleSpotEvent(payload: any) {
        const symbolId = Number(payload.symbolId);
        const bid = Number(payload.bid) / 100000;
        const ask = Number(payload.ask) / 100000;
        if (bid > 0) this.calculateIndicators(symbolId, bid, ask);
    }
}
