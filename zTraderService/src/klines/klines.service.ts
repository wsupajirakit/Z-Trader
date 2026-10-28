import { Injectable, Logger } from '@nestjs/common';
import { CtraderService } from '../ctrader/ctrader.service';

/** ProtoOATrendbar as decoded by protobufjs — int64 fields may arrive as Long, so read them via Number(). */
interface ProtoTrendbar {
    low: unknown;
    deltaOpen: unknown;
    deltaHigh: unknown;
    deltaClose: unknown;
    volume: unknown;
    utcTimestampInMinutes: number;
}

@Injectable()
export class KlinesService {
    private readonly logger = new Logger(KlinesService.name);

    // Common Symbol ID Mapping (Demo/Live might differ, but for Demo XAUUSD is usually consistent or should be queried)
    // For now, using standard mapping or assuming user provides it.
    // XAUUSD is often symbolId 1 on many cTrader demo servers, but let's check or allow dynamic.
    // The user mentioned XAUUSD (ทอง).
    private readonly symbolMapping: Record<string, number> = {
        XAUUSD: 41,
        EURUSD: 1,
        GBPUSD: 2,
    };

    private readonly periodMapping: Record<string, number> = {
        M1: 1,
        M2: 2,
        M3: 3,
        M4: 4,
        M5: 5,
        M10: 6,
        M15: 7,
        M30: 8,
        H1: 9,
        H4: 10,
        H12: 11,
        D1: 12,
        W1: 13,
        MN1: 14,
    };

    constructor(private ctraderService: CtraderService) {}

    async getKlines(symbol: string, period: string, limit: number = 100) {
        const symbolId = this.symbolMapping[symbol.toUpperCase()];
        if (!symbolId) {
            throw new Error(`Symbol ${symbol} not supported in mapping`);
        }

        const periodId = this.periodMapping[period.toUpperCase()];
        if (!periodId) {
            throw new Error(`Period ${period} not supported. Use M1, M5, H1, etc.`);
        }

        const toTimestamp = Date.now();
        const fromTimestamp = toTimestamp - limit * 10 * 60 * 1000; // 10x the limit in minutes to be safe

        const payload = {
            ctidTraderAccountId: this.ctraderService.activeAccountId,
            symbolId: symbolId,
            period: periodId,
            fromTimestamp: fromTimestamp,
            toTimestamp: toTimestamp,
            count: limit,
        };

        this.logger.log(`Fetching ${limit} klines for ${symbol} (${period}) with payload: ${JSON.stringify(payload)}`);

        const response: any = await this.ctraderService.request('ProtoOAGetTrendbarsReq', payload);
        this.logger.debug(`Raw response from cTrader: ${JSON.stringify(response)}`);

        if (!response.trendbar || response.trendbar.length === 0) {
            this.logger.warn(`No klines returned for ${symbol}`);
            return [];
        }

        // cTrader OpenAPI v2 handles most prices in 1/100,000 of unit
        const denominator = 100000;
        const digits = symbol.toUpperCase() === 'XAUUSD' ? 2 : 5;

        return (response.trendbar as ProtoTrendbar[]).map((bar) => {
            const low = Number(bar.low);
            const open = (low + Number(bar.deltaOpen)) / denominator;
            const high = (low + Number(bar.deltaHigh)) / denominator;
            const low_actual = low / denominator;
            const close = (low + Number(bar.deltaClose)) / denominator;

            return {
                timestamp: bar.utcTimestampInMinutes * 60 * 1000,
                open: parseFloat(open.toFixed(digits)),
                high: parseFloat(high.toFixed(digits)),
                low: parseFloat(low_actual.toFixed(digits)),
                close: parseFloat(close.toFixed(digits)),
                volume: Number(bar.volume),
            };
        });
    }
}
