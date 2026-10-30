import { Module } from '@nestjs/common';
import { CtraderModule } from '../ctrader/ctrader.module';
import { GoldModule } from '../gold/gold.module';
import { TradingViewModule } from '../integrations/tradingview/tradingview.module';
import { ChartController } from './chart.controller';
import { ChartService } from './chart.service';

@Module({
    imports: [CtraderModule, GoldModule, TradingViewModule],
    controllers: [ChartController],
    providers: [ChartService],
    exports: [ChartService],
})
export class ChartModule {}
