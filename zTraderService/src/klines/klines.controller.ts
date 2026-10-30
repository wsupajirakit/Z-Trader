import { Controller, Get, Query, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CtraderService } from '../ctrader/ctrader.service';
import { ApiKeyAuth } from '../common/auth/auth.decorators';
import { LiveDataService } from './live-data.service';
import { errorMessage } from '../common/utils/errors';

@Controller('api/v1/klines')
@ApiKeyAuth()
export class KlinesController {
    private readonly logger = new Logger(KlinesController.name);
    // Caching disabled per user request: "ห้ามแคช ดึงสดใหม่ทุกครั้ง"

    constructor(
        private readonly ctraderService: CtraderService,
        private readonly liveDataService: LiveDataService,
    ) {}

    @Get()
    async getKlines(
        @Query('symbol') symbol: string,
        @Query('period') period: string = 'M5',
        @Query('limit') limit: number = 100,
    ) {
        if (!symbol) {
            throw new HttpException('Symbol is required', HttpStatus.BAD_REQUEST);
        }

        try {
            if (!this.ctraderService.activeAccountId || !this.ctraderService.isAuthorized) {
                this.logger.warn('cTrader account not authorized yet. Retrying...');
                throw new HttpException('cTrader account not authorized yet', HttpStatus.SERVICE_UNAVAILABLE);
            }

            // 1. Get Symbol Info (Always fetch fresh, no cache)
            this.logger.log(`[DEBUG] Fetching fresh Symbol ID for: ${symbol}`);
            const symbolsListRes = await this.ctraderService.request<any>('ProtoOASymbolsListReq', {
                ctidTraderAccountId: this.ctraderService.activeAccountId,
                includeArchivedSymbols: false,
            });

            if (!symbolsListRes || !symbolsListRes.symbol) {
                this.logger.error('[DEBUG] Failed to get symbols list or list is empty');
                throw new Error('Empty symbols list from cTrader');
            }

            const symbolInfo = symbolsListRes.symbol.find((s: any) => s.symbolName === symbol);
            if (!symbolInfo) {
                this.logger.error(`[DEBUG] Symbol ${symbol} not found in available symbols`);
                throw new HttpException(`Symbol ${symbol} not found`, HttpStatus.NOT_FOUND);
            }

            const symbolId = Number(symbolInfo.symbolId);
            const digits = symbolInfo.digits || (symbol.includes('XAU') ? 2 : 5);

            // 2. Ensure real-time subscription is active for this symbol
            await this.liveDataService.subscribeSymbol(symbolId, symbol);

            // 3. Map period to TrendbarPeriod
            const trendbarPeriod = this.mapPeriod(period);

            // 4. Get Trendbars
            const toTimestamp = Date.now();
            const fromTimestamp = toTimestamp - limit * this.getPeriodMs(period);

            this.logger.debug(
                `[DEBUG] Fetching Trendbars for Symbol ID ${symbolId} from ${fromTimestamp} to ${toTimestamp}`,
            );
            const trendbarsRes = await this.ctraderService.request<any>('ProtoOAGetTrendbarsReq', {
                ctidTraderAccountId: this.ctraderService.activeAccountId,
                fromTimestamp,
                toTimestamp,
                period: trendbarPeriod,
                symbolId: symbolId,
            });

            this.logger.log(`[DEBUG] Received ${trendbarsRes?.trendbar?.length || 0} bars from cTrader`);

            if (!trendbarsRes) {
                this.logger.error('[DEBUG] trendbarsRes is undefined');
                throw new Error('Trendbar response is empty');
            }

            // 5. Reconstruct Bars
            const bars = this.reconstructBars(trendbarsRes, digits);
            return bars;
        } catch (error) {
            console.error('Klines Error:', error);
            if (error instanceof HttpException) throw error;
            throw new HttpException(errorMessage(error) || 'Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @Get('live')
    async getLiveKlines(@Query('symbol') symbol: string, @Query('maxPositions') maxPositions?: number) {
        this.logger.log(`[DEBUG] Hit GET /live for symbol: ${symbol}, maxPositions: ${maxPositions || 1}`);
        if (!symbol) {
            throw new HttpException('Symbol is required', HttpStatus.BAD_REQUEST);
        }

        try {
            // 1. Get Symbol ID
            const symbolsListRes = await this.ctraderService.request<any>('ProtoOASymbolsListReq', {
                ctidTraderAccountId: this.ctraderService.activeAccountId,
                includeArchivedSymbols: false,
            });
            const symbolInfo = symbolsListRes.symbol.find((s: any) => s.symbolName === symbol);
            if (!symbolInfo) throw new HttpException(`Symbol ${symbol} not found`, HttpStatus.NOT_FOUND);

            // 2. Ensure real-time subscription is active
            const symbolId = Number(symbolInfo.symbolId);
            await this.liveDataService.subscribeSymbol(symbolId, symbol, maxPositions ? Number(maxPositions) : 1);

            // 3. Return from In-Memory Cache
            return this.liveDataService.getLatestBars(symbolId);
        } catch (error) {
            throw new HttpException(errorMessage(error) || 'Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @Get('positions')
    async getPositions() {
        this.logger.log(`[DEBUG] Hit GET /positions`);
        if (!this.ctraderService.activeAccountId || !this.ctraderService.isAuthorized) {
            throw new HttpException('cTrader account not authorized yet', HttpStatus.SERVICE_UNAVAILABLE);
        }

        try {
            // Reconcile provides active positions
            const res = await this.ctraderService.request<any>('ProtoOAReconcileReq', {
                ctidTraderAccountId: this.ctraderService.activeAccountId,
                returnAccountDetails: false,
            });
            return res.position || [];
        } catch (error) {
            console.error('Positions Error:', error);
            throw new HttpException(errorMessage(error) || 'Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @Get('account')
    async getAccount() {
        if (!this.ctraderService.activeAccountId || !this.ctraderService.isAuthorized) {
            throw new HttpException('cTrader account not authorized yet', HttpStatus.SERVICE_UNAVAILABLE);
        }

        try {
            const res = await this.ctraderService.request<any>('ProtoOATraderReq', {
                ctidTraderAccountId: this.ctraderService.activeAccountId,
            });
            return res.trader || {};
        } catch (error) {
            console.error('Account Error:', error);
            throw new HttpException(errorMessage(error) || 'Internal Server Error', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    private mapPeriod(period: string): number {
        const mapping: Record<string, number> = {
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
        return mapping[period.toUpperCase()] || 5;
    }

    private getPeriodMs(period: string): number {
        const min = 60 * 1000;
        const mapping: Record<string, number> = {
            M1: min,
            M5: 5 * min,
            M15: 15 * min,
            M30: 30 * min,
            H1: 60 * min,
            H4: 240 * min,
            D1: 1440 * min,
        };
        return mapping[period.toUpperCase()] || 5 * min;
    }

    private reconstructBars(res: any, digits: number) {
        if (!res.trendbar || res.trendbar.length === 0) return [];
        const factor = 100000;

        const bars = res.trendbar.map((bar: any) => {
            const low = Number(bar.low);
            const open = (low + Number(bar.deltaOpen)) / factor;
            const high = (low + Number(bar.deltaHigh)) / factor;
            const close = (low + Number(bar.deltaClose)) / factor;
            const absoluteLow = low / factor;

            return {
                timestamp: Number(bar.utcTimestampInMinutes) * 60 * 1000,
                open: Number(open.toFixed(digits)),
                high: Number(high.toFixed(digits)),
                low: Number(absoluteLow.toFixed(digits)),
                close: Number(close.toFixed(digits)),
                volume: Number(bar.volume),
            };
        });

        // Filter out invalid bars
        return bars.filter((b: any) => b.close > 0 && b.high > 0);
    }
}
