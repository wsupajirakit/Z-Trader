import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './schemas/order.schema';
import { OrdersController } from './orders.controller';
import { ExecutionModule } from '../execution/execution.module';
import { forwardRef } from '@nestjs/common';
import { CtraderModule } from '../ctrader/ctrader.module';
import { AuditModule } from '../audit/audit.module';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Order.name, schema: OrderSchema }]),
        forwardRef(() => ExecutionModule),
        CtraderModule,
        AuditModule,
    ],
    providers: [OrdersService],
    exports: [OrdersService],
    controllers: [OrdersController],
})
export class OrdersModule {}
