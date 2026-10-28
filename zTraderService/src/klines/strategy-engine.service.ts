import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { ExecutionService } from '../execution/execution.service';
import { OrdersService } from '../orders/orders.service';
import { CtraderService } from '../ctrader/ctrader.service';
import { randomUUID } from 'crypto';
import { errorMessage } from '../common/utils/errors';

@Injectable()
export class StrategyEngineService {
    private readonly logger = new Logger(StrategyEngineService.name);
    private isEngineActive = true;
    private lastPositionCheck: Map<number, number> = new Map();
    private cachedHasPositions: Map<number, boolean> = new Map();

    // Track pending limit/stop orders for conditional cancellation
    private pendingOrders: Map<number, any[]> = new Map<number, any[]>();

    // Scalper Daily Trackers
    private scalperTradeCount = { day: new Date().getDate(), count: 0 };
    private scalperConsecutiveLosses = 0;
    private scalperDisabledToday = false;

    constructor(
        private readonly executionService: ExecutionService,
        private readonly ordersService: OrdersService,
        private readonly ctraderService: CtraderService,
        private readonly configService: ConfigService,
    ) {}

    @OnEvent('indicators.updated')
    async handleIndicatorUpdate(payload: any) {
        if (!this.isEngineActive) return;

        const { strategy } = payload;

        if (strategy === 'SONIC') {
            await this.handleSonicUpdate(payload);
        } else if (strategy === 'HIGH_WIN_RATE') {
            await this.handleHighWinRateUpdate(payload);
        } else if (strategy === 'SCALPER') {
            await this.handleScalperUpdate(payload);
        }
    }

    private async handleScalperUpdate(payload: any) {
        // Daily rollover check
        const today = new Date().getDate();
        if (this.scalperTradeCount.day !== today) {
            this.scalperTradeCount = { day: today, count: 0 };
            this.scalperConsecutiveLosses = 0;
            this.scalperDisabledToday = false;
        }

        if (this.scalperDisabledToday) return; // 2 consecutive losses today
        if (this.scalperTradeCount.count >= 6) return; // Max 6 trades/day

        const {
            symbolId,
            symbol,
            price,
            rsi,
            ema20,
            ema50,
            ask,
            bid,
            recentBars,
            tickVolume,
            avgVolume,
            ema20M15,
            ema50M15,
            h1Ema50,
            lastAtr,
            atrMa20,
            entryPeriod,
        } = payload;

        // Ensure max open positions
        if (await this.hasReachedMaxPositions(symbolId, payload.maxPositions || 1)) return;

        // Spread Guard: < 25 Pips (< $0.25)
        const spread = ask - bid;
        if (spread >= 0.25) return;

        // 1. H1 Trend Gate & 2. M15 Trend Confirm
        const isH1Buy = price > h1Ema50;
        const isH1Sell = price < h1Ema50;
        const isM15Buy = ema20M15 > ema50M15;
        const isM15Sell = ema20M15 < ema50M15;

        if (!(isH1Buy && isM15Buy) && !(isH1Sell && isM15Sell)) return; // Must align

        // 3. ATR Guard: ATR > 40% of ATR MA20
        if (lastAtr < atrMa20 * 0.4) return;

        // 4. RSI Guard: Range 45 to 55 (Classic Momentum Zone)
        if (rsi < 45 || rsi > 55) return;

        // 5. Volume Filter: Tick volume >= 50% of MA20
        if (tickVolume < avgVolume * 0.5) return;

        // 6. Pullback Zone: Price proximity to EMA20/50 (20 pips)
        const pipsToEma20 = Math.abs(price - ema20) / 0.01;
        const pipsToEma50 = Math.abs(price - ema50) / 0.01;
        if (pipsToEma20 > 20 && pipsToEma50 > 20) return;

        // 7. PA Confirmation
        const paPattern = this.detectPriceAction(recentBars);
        if (paPattern === 'NONE') return;

        // Setup Valid - Execute Trade
        const isBuySetup =
            isH1Buy &&
            isM15Buy &&
            (paPattern === 'BULL_ENGULFING' ||
                paPattern === 'HAMMER' ||
                paPattern === 'PINBAR_BULL' ||
                paPattern === 'INSIDE_BAR' ||
                paPattern === 'STRONG_CLOSE_BULL');
        const isSellSetup =
            isH1Sell &&
            isM15Sell &&
            (paPattern === 'BEAR_ENGULFING' ||
                paPattern === 'SHOOTING_STAR' ||
                paPattern === 'PINBAR_BEAR' ||
                paPattern === 'INSIDE_BAR' ||
                paPattern === 'STRONG_CLOSE_BEAR');

        if (isBuySetup || isSellSetup) {
            this.cachedHasPositions.set(symbolId, true);
            this.lastPositionCheck.set(symbolId, Date.now() + 5000);

            const side = isBuySetup ? 'BUY' : 'SELL';
            const rationale = `[Scalper M${entryPeriod}] PA:${paPattern} | Spread:${spread.toFixed(2)} | RSI:${rsi.toFixed(0)}`;

            await this.executeScalperTrade(symbol, symbolId, side, price, rationale);
        }
    }

    private async handleSonicUpdate(payload: any) {
        const { symbolId, symbol, price, rsi, ema50, ask, bid, recentBars, tickVolume, avgVolume } = payload;
        if (await this.hasReachedMaxPositions(symbolId, payload.maxPositions || 1)) return;

        const paPattern = this.detectPriceAction(recentBars);

        const isBuySignal =
            price > ema50 &&
            rsi < 65 &&
            tickVolume >= avgVolume * 0.4 &&
            ask - bid < 0.35 &&
            payload.h1TrendBuy &&
            paPattern !== 'NONE';
        const isSellSignal =
            price < ema50 &&
            rsi > 35 &&
            tickVolume >= avgVolume * 0.4 &&
            ask - bid < 0.35 &&
            payload.h1TrendSell &&
            paPattern !== 'NONE';

        if (isBuySignal || isSellSignal) {
            // Preemptively block next immediate tick
            this.cachedHasPositions.set(symbolId, true);
            this.lastPositionCheck.set(symbolId, Date.now() + 5000); // Prevent check for 5s

            const side = isBuySignal ? 'BUY' : 'SELL';
            const rationale = `[${symbol} ${side}] Sonic PA:${paPattern}`;
            await this.executeSonicTrade(symbol, symbolId, side, price, rationale);
        }
    }

    private async handleHighWinRateUpdate(payload: any) {
        const {
            symbolId,
            symbol,
            price,
            rsiM15,
            ema20M15,
            ema50M15,
            h1Ema50,
            h4Ema50,
            lastAtr,
            atrMa20,
            bid,
            ask,
            tickVolume,
            avgVolume,
            m15Bars,
        } = payload;

        // 0. Monitor Pending Orders for cancellation
        this.monitorPendingOrders(symbolId, bid, ask);

        if (await this.hasReachedMaxPositions(symbolId, payload.maxPositions)) return;

        const spread = ask - bid;
        if (spread > this.getSpreadLimit(symbol)) return;

        // RELAXED TREND: H4 must agree, then either H1 price or M15 EMA crossover
        const isTrendBuy = price > h4Ema50 && (price > h1Ema50 || ema20M15 > ema50M15);
        const isTrendSell = price < h4Ema50 && (price < h1Ema50 || ema20M15 < ema50M15);

        const isVolatile = lastAtr > atrMa20 * 0.5; // Relaxed from 0.7

        const paReason = this.detectPriceAction(m15Bars);
        const hasMomentumVolume = tickVolume >= avgVolume * 0.5; // Relaxed from 0.75

        // RELAXED RSI: Expanded range for more entries
        const rsiBuyOK = rsiM15 >= 38 && rsiM15 <= 62;
        const rsiSellOK = rsiM15 >= 38 && rsiM15 <= 62;

        // SCENARIO 1: Market Order (PA Close + Strong Momentum)
        if (isVolatile && hasMomentumVolume && paReason !== 'NONE') {
            if (isTrendBuy && rsiBuyOK) {
                this.cachedHasPositions.set(symbolId, true);
                this.lastPositionCheck.set(symbolId, Date.now() + 5000);
                await this.executeHighWinRateTrade(
                    symbol,
                    symbolId,
                    'BUY',
                    ask,
                    `Market Entry: PA(${paReason}) confirmed`,
                    m15Bars,
                    'MARKET',
                );
                return;
            }
            if (isTrendSell && rsiSellOK) {
                this.cachedHasPositions.set(symbolId, true);
                this.lastPositionCheck.set(symbolId, Date.now() + 5000);
                await this.executeHighWinRateTrade(
                    symbol,
                    symbolId,
                    'SELL',
                    bid,
                    `Market Entry: PA(${paReason}) confirmed`,
                    m15Bars,
                    'MARKET',
                );
                return;
            }
        }

        // SCENARIO 2: Limit Order (Approaching EMA20)
        // Check if price is within 15 pips of EMA20 but not yet touched
        const pipsFactor = this.getPipsFactor(symbol);
        if (isTrendBuy && rsiBuyOK && bid > ema20M15 && bid - ema20M15 < 15 * pipsFactor) {
            this.cachedHasPositions.set(symbolId, true);
            this.lastPositionCheck.set(symbolId, Date.now() + 5000);
            const entryPrice = ema20M15 + 5 * pipsFactor; // Buffer 5 pips
            await this.placePendingOrder(symbol, symbolId, 'BUY', entryPrice, 'LIMIT', rsiM15, m15Bars);
        } else if (isTrendSell && rsiSellOK && ask < ema20M15 && ema20M15 - ask < 15 * pipsFactor) {
            this.cachedHasPositions.set(symbolId, true);
            this.lastPositionCheck.set(symbolId, Date.now() + 5000);
            const entryPrice = ema20M15 - 5 * pipsFactor;
            await this.placePendingOrder(symbol, symbolId, 'SELL', entryPrice, 'LIMIT', rsiM15, m15Bars);
        }

        // SCENARIO 3: Stop Order (Breakout)
        // If trend is strong but no PA yet, or price is consolidating near high/low
        if (isTrendBuy && rsiM15 > 50 && rsiM15 < 65 && !hasMomentumVolume) {
            this.cachedHasPositions.set(symbolId, true);
            this.lastPositionCheck.set(symbolId, Date.now() + 5000);
            const triggerHigh = Math.max(...m15Bars.map((b: { high: number }) => b.high));
            const entryPrice = triggerHigh + 3 * pipsFactor;
            await this.placePendingOrder(symbol, symbolId, 'BUY', entryPrice, 'STOP', rsiM15, m15Bars);
        } else if (isTrendSell && rsiM15 < 50 && rsiM15 > 35 && !hasMomentumVolume) {
            this.cachedHasPositions.set(symbolId, true);
            this.lastPositionCheck.set(symbolId, Date.now() + 5000);
            const triggerLow = Math.min(...m15Bars.map((b: { low: number }) => b.low));
            const entryPrice = triggerLow - 3 * pipsFactor;
            await this.placePendingOrder(symbol, symbolId, 'SELL', entryPrice, 'STOP', rsiM15, m15Bars);
        }
    }

    private monitorPendingOrders(symbolId: number, bid: number, ask: number) {
        const orders = this.pendingOrders.get(symbolId) || [];
        if (orders.length === 0) return;

        const updatedOrders: any[] = [];
        for (const order of orders) {
            // Rule: "ถ้าราคาทะลุ SL Level ลงไปก่อนโดน Limit -> ยกเลิกทันที"
            const isBuyCancel = order.side === 'BUY' && bid < order.slPrice;
            const isSellCancel = order.side === 'SELL' && ask > order.slPrice;

            if (isBuyCancel || isSellCancel) {
                this.logger.log(
                    `[STRATEGY] Cancelling ${order.type} Order for Sym=${symbolId}: Price hit SL level before entry.`,
                );
                // In a real scenario, we'd call cTrader to cancel the pending order
                // For now, we just remove from our tracking and let cTrader handle SL if it hit
                continue;
            }
            updatedOrders.push(order);
        }
        this.pendingOrders.set(symbolId, updatedOrders);
    }

    private async placePendingOrder(
        symbol: string,
        symbolId: number,
        side: 'BUY' | 'SELL',
        entryPrice: number,
        type: 'LIMIT' | 'STOP',
        rsi: number,
        bars: any[],
    ) {
        // Prevent duplicate pending orders for same symbol/side
        const existing = this.pendingOrders.get(symbolId) || [];
        if (existing.some((o) => o.side === side && o.type === type)) return;

        const triggerBar = bars[bars.length - 1];
        const pipsFactor = this.getPipsFactor(symbol);
        const slPrice = side === 'BUY' ? triggerBar.low - 10 * pipsFactor : triggerBar.high + 10 * pipsFactor;

        const uuid = randomUUID();
        const order = { uuid, symbol, symbolId, side, entryPrice, type, slPrice, rsiAtPlacement: rsi };

        existing.push(order);
        this.pendingOrders.set(symbolId, existing);

        this.logger.log(
            `[STRATEGY] Placing ${type} ${side} for ${symbol} at ${entryPrice.toFixed(5)}, SL: ${slPrice.toFixed(5)}`,
        );

        // Calculate SL/TP pips for executeTrade
        const slPips = Math.abs(entryPrice - slPrice) / pipsFactor;
        const tpPips = slPips * 2;

        await this.executeTrade(
            symbol,
            symbolId,
            side,
            entryPrice,
            slPips,
            tpPips,
            `Pending ${type} Entry: RSI(${rsi.toFixed(1)})`,
            `HIGH_WIN_RATE-${type}`,
            0.02,
            type,
        );
    }

    private async hasReachedMaxPositions(symbolId: number, max: number): Promise<boolean> {
        const now = Date.now();
        const lastCheck = this.lastPositionCheck.get(symbolId) || 0;

        if (now - lastCheck > 2000) {
            this.lastPositionCheck.set(symbolId, now);
            try {
                const res = await this.ctraderService.getPositions();
                const positions = res || [];

                // 1. Check Global Limit (Across all symbols)
                const globalMax = Number(this.configService.get('ALL_MAX_POSITIONS', 100));
                if (positions.length >= globalMax) {
                    this.logger.warn(`[LIMIT] Global position limit reached: ${positions.length}/${globalMax}`);
                    this.cachedHasPositions.set(symbolId, true);
                    return true;
                }

                // 2. Check Per-Symbol Limit
                const active = positions.filter((p: any) => Number(p.tradeData.symbolId) === Number(symbolId)).length;
                this.cachedHasPositions.set(symbolId, active >= max);
            } catch (e) {
                return true;
            }
        }
        return this.cachedHasPositions.get(symbolId) || false;
    }

    private isHighWinRateSessionActive(_symbol: string): boolean {
        return true; // 24/7 scanning enabled
    }

    private getSpreadLimit(symbol: string): number {
        if (symbol === 'EURUSD') return 0.00012;
        if (symbol === 'USDJPY') return 0.02;
        if (symbol === 'BTCUSD') return 50;
        return 0.35;
    }

    private getPipsFactor(symbol: string): number {
        if (symbol.includes('JPY')) return 0.01;
        if (symbol === 'BTCUSD') return 1;
        if (symbol === 'XAUUSD') return 0.01;
        return 0.0001;
    }

    private isNearRoundNumber(price: number, buffer: number): boolean {
        const round = Math.round(price / 5000) * 5000;
        return Math.abs(price - round) < buffer;
    }

    private getBkkHour(): number {
        return parseInt(
            new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }).format(
                new Date(),
            ),
        );
    }

    private isSessionActive(_session: 'ASIA'): boolean {
        return false; // Time filter disabled
    }

    private async executeScalperTrade(
        symbol: string,
        symbolId: number,
        side: 'BUY' | 'SELL',
        price: number,
        rationale: string,
    ) {
        const volume = process.env.TRADE_LOT_SIZE ? parseFloat(process.env.TRADE_LOT_SIZE) : 0.02; // Use configured or default 0.02 Lot (2000 Units)

        // XAUUSD Scalper strict TP = +100 pips ($1.00), SL = -70 pips ($0.70)
        await this.executeTrade(symbol, symbolId, side, price, 70, 100, rationale, 'SCALPER', volume, 'MARKET');
        this.scalperTradeCount.count += 1;
    }

    private async executeHighWinRateTrade(
        symbol: string,
        symbolId: number,
        side: 'BUY' | 'SELL',
        price: number,
        rationale: string,
        bars: any[],
        type: 'MARKET' | 'LIMIT' | 'STOP' = 'MARKET',
    ) {
        const triggerBar = bars[bars.length - 1];
        const pipsFactor = this.getPipsFactor(symbol);

        let slPips: number;
        if (symbol === 'BTCUSD') {
            slPips = 150;
        } else {
            const wickBuffer = 8 * pipsFactor;
            const sl = side === 'BUY' ? triggerBar.low - wickBuffer : triggerBar.high + wickBuffer;
            slPips = Math.abs(price - sl) / pipsFactor;
        }

        const tpPips = slPips * 2;
        await this.executeTrade(symbol, symbolId, side, price, slPips, tpPips, rationale, 'HIGH_WIN_RATE', 0.02, type);
    }

    private async executeSonicTrade(
        symbol: string,
        symbolId: number,
        side: 'BUY' | 'SELL',
        price: number,
        rationale: string,
    ) {
        const volume = process.env.TRADE_LOT_SIZE ? parseFloat(process.env.TRADE_LOT_SIZE) : 0.02;
        await this.executeTrade(symbol, symbolId, side, price, 400, 500, rationale, 'SONIC', volume, 'MARKET');
    }

    private async executeTrade(
        symbol: string,
        symbolId: number,
        side: 'BUY' | 'SELL',
        price: number,
        slPips: number,
        tpPips: number,
        rationale: string,
        strategy: string,
        volume: number,
        type: string = 'MARKET',
    ) {
        const uuid = randomUUID();
        const factor = this.getPipsFactor(symbol);

        const takeProfit = side === 'BUY' ? price + tpPips * factor : price - tpPips * factor;
        const stopLoss = side === 'BUY' ? price - slPips * factor : price + slPips * factor;

        try {
            await this.ordersService.createOrder({
                uuid,
                symbol,
                side,
                volume,
                orderType: type,
                takeProfit: Number(takeProfit.toFixed(5)),
                stopLoss: Number(stopLoss.toFixed(5)),
                status: 'PENDING',
                strategy,
                positionEvent: rationale,
                mode: this.configService.get('CTRADER_ACCOUNT_MODE', 'DEMO').toUpperCase(),
            });

            await this.executionService.executeOrder({
                uuid,
                symbol,
                side,
                volume,
                orderType: type,
                price: Number(price.toFixed(5)),
                takeProfit: Number(takeProfit.toFixed(5)),
                stopLoss: Number(stopLoss.toFixed(5)),
                comment: `${strategy}-${type}-${side}`,
            });

            this.cachedHasPositions.set(symbolId, true);
        } catch (error) {
            this.logger.error(`[STRATEGY] Failed to trigger ${strategy} trade: ${errorMessage(error)}`);
        }
    }

    private detectPriceAction(bars: any[]): string {
        if (!bars || bars.length < 2) return 'NONE';
        const current = bars[bars.length - 1];
        const prev = bars[bars.length - 2];
        const body = Math.abs(current.close - current.open);
        const upperWick = current.high - Math.max(current.open, current.close);
        const lowerWick = Math.min(current.open, current.close) - current.low;
        const fullRange = current.high - current.low;

        // Hammer / Shooting Star
        if (lowerWick > body * 2 && upperWick < body * 0.5) return 'HAMMER';
        if (upperWick > body * 2 && lowerWick < body * 0.5) return 'SHOOTING_STAR';

        // Pinbars
        if (lowerWick > body * 2) return 'PINBAR_BULL';
        if (upperWick > body * 2) return 'PINBAR_BEAR';

        // Engulfing
        if (
            current.close > current.open &&
            prev.close < prev.open &&
            current.close > prev.open &&
            current.open < prev.close
        )
            return 'BULL_ENGULFING';
        if (
            current.close < current.open &&
            prev.close > prev.open &&
            current.close < prev.open &&
            current.open > prev.close
        )
            return 'BEAR_ENGULFING';

        // Inside Bar
        if (current.high < prev.high && current.low > prev.low) return 'INSIDE_BAR';

        // Strong Close Candle (> 60% of Body)
        if (fullRange > 0) {
            const bodyRatio = body / fullRange;
            if (bodyRatio > 0.6) {
                if (current.close > current.open && current.close > current.low + fullRange * 0.7)
                    return 'STRONG_CLOSE_BULL';
                if (current.close < current.open && current.close < current.high - fullRange * 0.7)
                    return 'STRONG_CLOSE_BEAR';
            }
        }

        return 'NONE';
    }
}
