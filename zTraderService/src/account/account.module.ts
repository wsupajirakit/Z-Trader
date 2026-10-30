import { Module } from '@nestjs/common';
import { CtraderModule } from '../ctrader/ctrader.module';
import { AccountService } from './account.service';

@Module({
    imports: [CtraderModule],
    providers: [AccountService],
    exports: [AccountService],
})
export class AccountModule {}
