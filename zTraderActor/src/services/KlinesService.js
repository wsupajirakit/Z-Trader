import { tradeLog } from '../logging/logger.js';

export class KlinesService {
    /** @param {import('./ServiceClient.js').ServiceClient} api */
    constructor(api) {
        this.api = api;
    }

    async getKlines(symbol, period, limit = 100, maxPositions = 1) {
        try {
            return await this.api.get('/api/v1/klines', {
                query: {
                    symbol,
                    period,
                    limit,
                    maxPositions,
                    _: Date.now(), // Cache busting
                },
                timeoutMs: 10000,
            });
        } catch (error) {
            tradeLog.error(`Error fetching klines for ${symbol}:`, error.message);
            throw error;
        }
    }
}
