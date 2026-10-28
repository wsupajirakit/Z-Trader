import { Module } from '@nestjs/common';
import { KlinesController } from './klines.controller';
import { CtraderModule } from '../ctrader/ctrader.module';
import { LiveDataService } from './live-data.service';
import { KlinesGateway } from './klines.gateway';
import { StrategyEngineService } from './strategy-engine.service';
import { PositionMonitorService } from './position-monitor.service';
import { OrdersModule } from '../orders/orders.module';
import { ExecutionModule } from '../execution/execution.module';

@Module({
    imports: [CtraderModule, OrdersModule, ExecutionModule],
    controllers: [KlinesController],
    providers: [LiveDataService, KlinesGateway, StrategyEngineService, PositionMonitorService],
    exports: [LiveDataService],
})
export class KlinesModule {}
