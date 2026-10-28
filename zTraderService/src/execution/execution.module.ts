import { Module, forwardRef } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { OrdersModule } from '../orders/orders.module';
import { CtraderModule } from '../ctrader/ctrader.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
    imports: [forwardRef(() => OrdersModule), CtraderModule, TelegramModule],
    providers: [ExecutionService],
    exports: [ExecutionService],
})
export class ExecutionModule {}
