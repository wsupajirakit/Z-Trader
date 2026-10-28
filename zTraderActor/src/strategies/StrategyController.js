import { tradeLog } from '../logging/logger.js';

export class StrategyController {
    /**
     * @param {{
     *   api: import('../services/ServiceClient.js').ServiceClient,
     *   klinesService: import('../services/KlinesService.js').KlinesService,
     *   newsService: import('../services/NewsService.js').NewsService,
     *   indicatorService: import('../services/IndicatorService.js').IndicatorService,
     *   tradeDispatcher: import('../services/TradeDispatcher.js').TradeDispatcher,
     * }} deps
     */
    constructor({ api, klinesService, newsService, indicatorService, tradeDispatcher }) {
        this.api = api;
        this.klinesService = klinesService;
        this.newsService = newsService;
        this.indicatorService = indicatorService;
        this.tradeDispatcher = tradeDispatcher;
        this.mode = 'Conservative';
    }

    setMode(mode) {
        this.mode = mode;
        tradeLog.info(`\n====================================`);
        tradeLog.info(`   Strategy Mode set to: ${this.mode}`);
        tradeLog.info(`====================================`);
    }

    async run(symbol, period = 'M5', maxPositions = 1) {
        // Clear line before printing new status
        tradeLog.status(`\r\u001b[2K[คิด] กำลังวิเคราะห์กลยุทธ์ ${this.mode} สำหรับ ${symbol} (${period})...`);

        // New: Guard against existing positions (Skip for Sonic as Backend handles it)
        if (this.mode !== 'Sonic') {
            try {
                const positions = await this.api.get('/api/v1/klines/positions', {
                    timeoutMs: 10000, // 10s timeout
                });
                const activePosition = positions.find((p) => p.symbolName === symbol);
                if (activePosition) {
                    tradeLog.status(`\n[รอ] มี Position ${symbol} เปิดค้างไว้แล้ว ข้ามการวิเคราะห์รอบนี้...\n`);
                    return;
                }
            } catch (e) {
                if (e.status === 503) {
                    tradeLog.status(`\n[รอ] บริการยังไม่พร้อม (cTrader Auth)...`);
                    return;
                }
                tradeLog.error(`\n[รอ] Positions Check Failed: ${e.message} (Code: ${e.code})`);
                // If it's a timeout or connection error, we might want to return early or proceed with caution
                if (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED') return;
            }
        }

        // Step 1: Check News (if not Swing mode or Sonic mode)
        if (this.mode !== 'Swing' && this.mode !== 'Sonic') {
            const isNewsRestricted = await this.newsService.checkNewsFilter();
            if (isNewsRestricted) {
                tradeLog.info('\n[รอ] Strategy: News restriction active. Skipping trade check.');
                if (this.mode === 'Hardcode' || this.mode === 'Merge') {
                    return;
                }
            }
        }

        // Step 2: Fetch Market Data and Run Strategy Logic
        switch (this.mode) {
            case 'Hardcode':
                await this.runHardcodeFlow(symbol, period);
                break;
            case 'Conservative':
                await this.runConservativeFlow(symbol, period);
                break;
            case 'Swing':
                await this.runSwingFlow(symbol, period);
                break;
            case 'Merge':
                await this.runMerge(symbol, period);
                break;
            case 'Sonic':
                await this.runSonic(symbol, maxPositions);
                break;
            case 'Scalper':
                await this.runScalper(symbol, maxPositions);
                break;
            default:
                tradeLog.info(`\n[รอ] โหมดที่ไม่รู้จัก: ${this.mode}`);
        }
        tradeLog.status(`\n[รอ] เสร็จสิ้นรอบการทำงาน กำลังรอรอบถัดไป...\n`);
    }

    async runMerge(symbol, entryPeriod = 'M5') {
        const trendPeriod = 'M15';
        tradeLog.status(
            `\n[คิด] วิเคราะห์โหมด Merge: มองใหญ่ (${trendPeriod}, EMA200) ยิงเล็ก (${entryPeriod}, RSI+BB)...`,
        );

        // 1. Fetch M15 for Trend (EMA 200)
        let klinesM15;
        try {
            klinesM15 = await this.klinesService.getKlines(symbol, trendPeriod, 250);
        } catch (e) {
            return;
        }

        const pricesM15 = klinesM15.map((k) => parseFloat(k.close));
        if (pricesM15.length < 200) {
            tradeLog.status(`\n[รอ] ข้อมูล M15 ไม่เพียงพอสำหรับ EMA200 (มีแค่ ${pricesM15.length})...`);
            return;
        }

        const ema200List = this.indicatorService.calculateEMA(pricesM15, 200);
        const lastEMA200 = ema200List[ema200List.length - 1];
        const lastPriceM15 = pricesM15[pricesM15.length - 1];
        const trend = lastPriceM15 > lastEMA200 ? 'UP' : 'DOWN';

        tradeLog.info(
            `\n      - [M15 Trend: ${trend}] Price=${lastPriceM15.toFixed(2)}, EMA200=${lastEMA200.toFixed(2)}`,
        );

        // 2. Fetch M5 for Entry (Setup)
        let klinesM5;
        try {
            klinesM5 = await this.klinesService.getKlines(symbol, entryPeriod, 50);
        } catch (e) {
            return;
        }

        const pricesM5 = klinesM5.map((k) => parseFloat(k.close));
        const rsi = this.indicatorService.calculateRSI(pricesM5, 14);
        const bb = this.indicatorService.calculateBollingerBands(pricesM5, 20, 2);

        const lastRSI = rsi[rsi.length - 1];
        const lastBB = bb[bb.length - 1];
        const lastPriceM5 = pricesM5[pricesM5.length - 1];
        const lastBarTime = new Date(klinesM5[klinesM5.length - 1].timestamp).toLocaleTimeString('th-TH');

        tradeLog.info(
            `      - [M5 Setup]: RSI=${lastRSI.toFixed(2)}, Price=${lastPriceM5.toFixed(2)}, Time=${lastBarTime}`,
        );
        tradeLog.info(`      - [BB Bounds]: Low=${lastBB.lower.toFixed(2)}, High=${lastBB.upper.toFixed(2)}`);

        // 3. Entry Logic Integration (Merge uses LIMIT at BB edge)
        if (trend === 'UP' && lastRSI < 30 && lastPriceM5 <= lastBB.lower) {
            tradeLog.info('\n[ทำ] เงื่อนไขครบ: เทรนด์ขึ้น + RSI Oversold + แตะ BB Lower. วางวกับดัก BUY LIMIT!');
            const volume = await this.tradeDispatcher.calculateLotSize();
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'BUY',
                orderType: 'LIMIT',
                price: Number(lastBB.lower.toFixed(2)),
                stopLoss: Number((lastBB.lower - 2).toFixed(2)),
                takeProfit: Number(lastBB.middle.toFixed(2)),
                comment: 'Merge Strategy BUY LIMIT',
            });
        } else if (trend === 'DOWN' && lastRSI > 70 && lastPriceM5 >= lastBB.upper) {
            tradeLog.info('\n[ทำ] เงื่อนไขครบ: เทรนด์ลง + RSI Overbought + แตะ BB Upper. วางกับดัก SELL LIMIT!');
            const volume = await this.tradeDispatcher.calculateLotSize();
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'SELL',
                orderType: 'LIMIT',
                price: Number(lastBB.upper.toFixed(2)),
                stopLoss: Number((lastBB.upper + 2).toFixed(2)),
                takeProfit: Number(lastBB.middle.toFixed(2)),
                comment: 'Merge Strategy SELL LIMIT',
            });
        } else {
            tradeLog.status(`\r[รอ] วิเคราะห์เสร็จสิ้น: ยังไม่ครบเงื่อนไข 3 ชั้น... `);
        }
    }

    async runSonic(symbol, maxPositions = 1) {
        const entryPeriod = 'M5';
        // In Sonic mode, we only log if it's a fresh scan or significant event
        // The Actor handles the 'wiggle' display via socket.io
        // tradeLog.status(`\r\u001b[2K[คิด] วิเคราะห์โหมด SONIC (🏎️ Balanced) สำหรับ ${symbol}...`);

        // 1. Fetch M1 for Entry
        let klinesM1;
        try {
            klinesM1 = await this.klinesService.getKlines(symbol, entryPeriod, 100, maxPositions); // Need enough bars for EMA 25
        } catch (e) {
            tradeLog.error(`\n[รอ] GetKlines (M1) Failed: ${e.message}`);
            return;
        }

        const pricesM1 = klinesM1.map((k) => parseFloat(k.close));
        const rsi = this.indicatorService.calculateRSI(pricesM1, 14);
        const ema20List = this.indicatorService.calculateEMA(pricesM1, 20);

        const lastRSI = rsi[rsi.length - 1];
        const lastEMA20 = ema20List[ema20List.length - 1];
        const lastPrice = pricesM1[pricesM1.length - 1];
        const lastBarTime = new Date(klinesM1[klinesM1.length - 1].timestamp).toLocaleTimeString('th-TH');
        const nowTime = new Date().toLocaleTimeString('th-TH');

        tradeLog.info(`\n      - [Run Time]: ${nowTime}`);
        tradeLog.info(
            `      - [M5 Data]: Price=${lastPrice.toFixed(2)}, EMA20=${(lastEMA20 || 0).toFixed(2)}, RSI=${(lastRSI || 0).toFixed(2)}, BarTime=${lastBarTime}`,
        );

        // 2. Entry Logic (Balanced: Trend + Reversion) - DISABLED in Actor (Backend handles this now)
        /*
        if (lastPrice > lastEMA25 && lastRSI < 45) {
            ...
        }
        */
        tradeLog.status(`\r[รอ] Sonic: ยังไม่ครบเงื่อนไข Balanced (Backend handles execution)... `);
    }

    async runScalper(symbol, maxPositions = 1) {
        // Scalper is purely event-driven by the backend.
        // We hit the 'live' endpoint once to ensure the backend starts the subscription if it hasn't.
        try {
            await this.api.get('/api/v1/klines/live', {
                query: { symbol, maxPositions },
                timeoutMs: 5000,
            });
            tradeLog.status(`\r[ทํา] Scalper: ลอจิกถูกเช็คจากฝั่ง Backend (API Service)... `);
        } catch (e) {
            tradeLog.status(`\r[รอ] Scalper: Backend Ping Failed: ${e.message} `);
        }
    }

    // Helper flows to keep run() clean

    /* eslint-disable no-undef, no-unused-vars -- KNOWN BUG, kept on purpose (see README "Known issues"):
       `cross` is never computed here, so this flow throws a ReferenceError after fetching klines
       (caught and logged by the loop) and has never placed an order. Computing it would make
       Hardcode mode start trading, which is a decision for the strategy owner, not a refactor. */
    async runHardcodeFlow(symbol, period) {
        tradeLog.status(`\r[ทำ] กำลังดึงข้อมูล Klines...`);
        const klines = await this.klinesService.getKlines(symbol, period);
        const prices = klines.map((k) => parseFloat(k.close));

        const ema8 = this.indicatorService.calculateEMA(prices, 8);
        const ema21 = this.indicatorService.calculateEMA(prices, 21);
        const lastPrice = prices[prices.length - 1];
        const pipsValue = 0.01; // For Gold M5
        const tpPips = 300;
        const slPips = 200;

        if (cross === 'GOLDEN_CROSS') {
            const volume = await this.tradeDispatcher.calculateLotSize();
            const entryPrice = lastPrice + 20 * pipsValue; // BUY STOP 20 pips above
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'BUY',
                orderType: 'STOP',
                price: Number(entryPrice.toFixed(2)),
                takeProfit: Number((entryPrice + tpPips * pipsValue).toFixed(2)),
                stopLoss: Number((entryPrice - slPips * pipsValue).toFixed(2)),
                comment: 'Hardcode-BUY-STOP',
            });
        } else if (cross === 'DEATH_CROSS') {
            const volume = await this.tradeDispatcher.calculateLotSize();
            const entryPrice = lastPrice - 20 * pipsValue; // SELL STOP 20 pips below
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'SELL',
                orderType: 'STOP',
                price: Number(entryPrice.toFixed(2)),
                takeProfit: Number((entryPrice - tpPips * pipsValue).toFixed(2)),
                stopLoss: Number((entryPrice + slPips * pipsValue).toFixed(2)),
                comment: 'Hardcode-SELL-STOP',
            });
        }
    }
    /* eslint-enable no-undef, no-unused-vars */

    async runConservativeFlow(symbol, period) {
        tradeLog.status(`\r[ทำ] กำลังดึงข้อมูล Klines...`);
        const klines = await this.klinesService.getKlines(symbol, period);
        const prices = klines.map((k) => parseFloat(k.close));

        const rsi = this.indicatorService.calculateRSI(prices, 14);
        const ema8 = this.indicatorService.calculateEMA(prices, 8);
        const ema21 = this.indicatorService.calculateEMA(prices, 21);
        const bb = this.indicatorService.calculateBollingerBands(prices, 20, 2);

        const lastRSI = rsi[rsi.length - 1];
        const cross = this.indicatorService.checkEMACross(ema8, ema21);
        const lastPrice = prices[prices.length - 1];
        const lastBB = bb[bb.length - 1];

        const pipsValue = 0.01; // For Gold M5
        const tpPips = 250;
        const slPips = 150;

        if (cross === 'GOLDEN_CROSS' && lastRSI < 70 && lastPrice > lastBB.middle) {
            const volume = await this.tradeDispatcher.calculateLotSize();
            const entryPrice = lastPrice + 20 * pipsValue; // BUY STOP 20 pips above
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'BUY',
                orderType: 'STOP',
                price: Number(entryPrice.toFixed(2)),
                takeProfit: Number((entryPrice + tpPips * pipsValue).toFixed(2)),
                stopLoss: Number((entryPrice - slPips * pipsValue).toFixed(2)),
                comment: 'Conservative-BUY-STOP',
            });
        } else if (cross === 'DEATH_CROSS' && lastRSI > 30 && lastPrice < lastBB.middle) {
            const volume = await this.tradeDispatcher.calculateLotSize();
            const entryPrice = lastPrice - 20 * pipsValue; // SELL STOP 20 pips below
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'SELL',
                orderType: 'STOP',
                price: Number(entryPrice.toFixed(2)),
                takeProfit: Number((entryPrice - tpPips * pipsValue).toFixed(2)),
                stopLoss: Number((entryPrice + slPips * pipsValue).toFixed(2)),
                comment: 'Conservative-SELL-STOP',
            });
        }
    }

    async runSwingFlow(symbol, period) {
        tradeLog.status(`\r[ทำ] กำลังดึงข้อมูล Klines...`);
        const klines = await this.klinesService.getKlines(symbol, period);
        const prices = klines.map((k) => parseFloat(k.close));

        const rsi = this.indicatorService.calculateRSI(prices, 14);
        const bb = this.indicatorService.calculateBollingerBands(prices, 20, 2);

        const lastRSI = rsi[rsi.length - 1];
        const lastBB = bb[bb.length - 1];
        const lastPrice = prices[prices.length - 1];
        const lastBarTime = new Date(klines[klines.length - 1].timestamp).toLocaleTimeString('th-TH');

        tradeLog.info(`\n      - ราคาปัจจุบัน: ${lastPrice.toFixed(2)} (Time: ${lastBarTime})`);
        tradeLog.info(`      - RSI: ${lastRSI.toFixed(2)} (ต้องการ < 30 หรือ > 70)`);
        tradeLog.info(`      - Bollinger Bands: Low=${lastBB.lower.toFixed(2)}, High=${lastBB.upper.toFixed(2)}`);

        if (lastRSI < 30 && lastPrice <= lastBB.lower) {
            tradeLog.info('\n[ทำ] เงื่อนไขครบ: RSI Oversold + ราคาแตะ BB Lower. วางกับดัก BUY LIMIT!');
            const volume = await this.tradeDispatcher.calculateLotSize();
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'BUY',
                orderType: 'LIMIT',
                price: Number(lastBB.lower.toFixed(2)), // ช้อนที่ขอบล่าง
                takeProfit: Number(lastBB.middle.toFixed(2)), // เป้าที่เส้นกลาง
                stopLoss: Number((lastBB.lower - 2.0).toFixed(2)), // เผื่อสะบัดหลุดขอบล่าง $2
                comment: 'Swing-BUY-LIMIT',
            });
        } else if (lastRSI > 70 && lastPrice >= lastBB.upper) {
            tradeLog.info('\n[ทำ] เงื่อนไขครบ: RSI Overbought + ราคาแตะ BB Upper. วางกับดัก SELL LIMIT!');
            const volume = await this.tradeDispatcher.calculateLotSize();
            await this.tradeDispatcher.executeTrade({
                symbol,
                volume,
                side: 'SELL',
                orderType: 'LIMIT',
                price: Number(lastBB.upper.toFixed(2)), // ดักที่ขอบบน
                takeProfit: Number(lastBB.middle.toFixed(2)), // เป้าที่เส้นกลาง
                stopLoss: Number((lastBB.upper + 2.0).toFixed(2)), // เผื่อสะบัดทะลุขอบบน $2
                comment: 'Swing-SELL-LIMIT',
            });
        } else {
            tradeLog.status(`\r[รอ] ยังไม่มีสัญญาณเข้าเทรด... `);
        }
    }
}
