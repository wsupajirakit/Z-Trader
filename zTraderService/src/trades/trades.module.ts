import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CtraderModule } from '../ctrader/ctrader.module';
import { GoldModule } from '../gold/gold.module';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Trade, TradeSchema } from './schemas/trade.schema';
import { TradesService } from './trades.service';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Trade.name, schema: TradeSchema },
            { name: Order.name, schema: OrderSchema },
        ]),
        CtraderModule,
        GoldModule,
    ],
    providers: [TradesService],
    exports: [TradesService],
})
export class TradesModule {}
