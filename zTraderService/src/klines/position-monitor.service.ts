import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CtraderService } from '../ctrader/ctrader.service';
import { errorMessage } from '../common/utils/errors';

@Injectable()
export class PositionMonitorService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PositionMonitorService.name);
    private monitorInterval?: NodeJS.Timeout;

    constructor(private readonly ctraderService: CtraderService) {}

    onModuleInit() {
        this.logger.log('Position Monitor Service initialized. Monitoring every 5s.');
        this.monitorInterval = setInterval(() => void this.monitorPositions(), 5000);
    }

    onModuleDestroy() {
        if (this.monitorInterval) clearInterval(this.monitorInterval);
    }

    private async monitorPositions() {
        if (!this.ctraderService.isAuthorized) return;

        try {
            const res = await this.ctraderService.getPositions();
            const positions = res.position || [];

            for (const pos of positions) {
                // Only monitor 'SONIC' positions or positions with comments containing 'Sonic'
                const comment = pos.tradeData?.comment || '';
                if (!comment.includes('Sonic')) continue;

                await this.processTrailingStop(pos);
            }
        } catch (error) {
            this.logger.error(`Error monitoring positions: ${errorMessage(error)}`);
        }
    }

    private async processTrailingStop(pos: any) {
        const positionId = Number(pos.positionId);
        const side = pos.tradeData.tradeSide; // BUY or SELL
        const entryPrice = Number(pos.entryPrice) / 100000;
        const currentPrice = Number(pos.price) / 100000;
        const currentSL = pos.stopLoss ? Number(pos.stopLoss) / 100000 : null;

        const pipsValue = 0.01; // For Gold
        const profitPips =
            side === 'BUY' ? (currentPrice - entryPrice) / pipsValue : (entryPrice - currentPrice) / pipsValue;

        // Trailing Stop logic: 50 pips trail after 100 pips profit
        const trailingStartPips = 200;
        const trailDistancePips = 150;

        if (profitPips >= trailingStartPips) {
            // Target SL calculation
            const targetSL =
                side === 'BUY'
                    ? currentPrice - trailDistancePips * pipsValue
                    : currentPrice + trailDistancePips * pipsValue;

            // Check if we should move SL (only move forward, never back)
            let shouldUpdate = false;
            if (!currentSL) {
                shouldUpdate = true;
            } else {
                if (side === 'BUY' && targetSL > currentSL + 5 * pipsValue) {
                    // Move in groups of 5 pips to reduce API calls
                    shouldUpdate = true;
                } else if (side === 'SELL' && targetSL < currentSL - 5 * pipsValue) {
                    shouldUpdate = true;
                }
            }

            if (shouldUpdate) {
                try {
                    const rawSL = Math.round(targetSL * 100000);
                    await this.ctraderService.amendPositionSLTP(positionId, rawSL, pos.takeProfit);
                    this.logger.log(
                        `[TRAILING] Updated SL for Position ${positionId}: New SL ${targetSL.toFixed(2)} (${profitPips.toFixed(1)} pips in profit)`,
                    );
                } catch (e) {
                    this.logger.error(`Failed to update trailing SL for ${positionId}: ${errorMessage(e)}`);
                }
            }
        }
    }
}
