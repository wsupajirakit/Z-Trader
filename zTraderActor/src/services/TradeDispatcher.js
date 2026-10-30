import { randomUUID } from 'node:crypto';
import { tradeLog } from '../logging/logger.js';

/** X-Actor-User for orders the strategy loop places on its own. */
export const ORDER_ACTOR = 'actor-loop';

export class TradeDispatcher {
    /**
     * @param {import('./ServiceClient.js').ServiceClient} api
     * @param {{ tradeLotSize: number | null, tradeAmountUsd: number }} trading
     */
    constructor(api, trading) {
        this.api = api;
        this.tradeLotSize = trading.tradeLotSize;
        this.tradeAmountUsd = trading.tradeAmountUsd;
    }

    async executeTrade(params) {
        const { symbol, volume, side, orderType = 'MARKET', stopLoss, takeProfit, price, comment } = params;

        tradeLog.status(`\n[Exec] Sending order ${side} ${symbol} (Vol: ${volume})...`);

        const payload = {
            // No accountId: zTraderService decides which cTrader account trades (it only checks a sent one).
            uuid: randomUUID(),
            symbol,
            volume: Math.round(volume * 100) / 100, // Ensure 2 decimal places
            orderType,
            side,
            stopLoss,
            takeProfit,
            price,
            mode: params.mode || this.mode,
            comment: comment || 'Z Trader',
        };

        try {
            const data = await this.api.post('/orders', payload, { actor: ORDER_ACTOR });
            tradeLog.info(`Trade executed successfully [${side} ${symbol}]:`, data);
            return data;
        } catch (error) {
            const errorMsg = error.data ? JSON.stringify(error.data) : error.message;
            tradeLog.error(`\n[Wait] Order submission failed [${side} ${symbol}]:`, errorMsg);
            throw error;
        }
    }

    async getAccountBalance() {
        try {
            return await this.api.get('/api/v1/klines/account'); // returns { balance, moneyDigits, etc }
        } catch (error) {
            tradeLog.error('Failed to fetch account balance:', error.message);
            return null;
        }
    }

    async calculateLotSize() {
        // 1. Explicit Lot Size override from ENV (Highest Priority; validated > 0 at boot)
        if (this.tradeLotSize !== null) {
            return Math.max(0.01, parseFloat(this.tradeLotSize.toFixed(2)));
        }

        // 2. Fallback to automated risk calculation from TRADE_AMOUNT_USD
        // ยอดเงินจำลอง 10 USD
        const tradeAmount = this.tradeAmountUsd;

        // Balance-based sizing (MM) was never finished: the balance is fetched but not used.
        // The call is kept so behaviour (and its error logging) is unchanged.
        await this.getAccountBalance();

        // 5 USD risk -> ~ 0.02 lot for XAUUSD (Simplified, doubled original lot size)
        const volume = (tradeAmount / 5) * 0.02;
        return Math.max(0.01, parseFloat(volume.toFixed(2)));
    }
}
