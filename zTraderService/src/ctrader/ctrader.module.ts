import { Module } from '@nestjs/common';
import { CtraderService } from './ctrader.service';

@Module({
    providers: [CtraderService],
    exports: [CtraderService],
})
export class CtraderModule {}
