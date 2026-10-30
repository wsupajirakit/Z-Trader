import { Module } from '@nestjs/common';
import { AccountModule } from '../account/account.module';
import { AuditModule } from '../audit/audit.module';
import { CtraderModule } from '../ctrader/ctrader.module';
import { GoldModule } from '../gold/gold.module';
import { DashboardController } from './dashboard.controller';

@Module({
    imports: [GoldModule, CtraderModule, AuditModule, AccountModule],
    controllers: [DashboardController],
})
export class DashboardModule {}
