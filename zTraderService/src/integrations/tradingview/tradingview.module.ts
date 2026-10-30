import { Module } from '@nestjs/common';
import { TradingViewClient } from './tv-client';

@Module({
    providers: [TradingViewClient],
    exports: [TradingViewClient],
})
export class TradingViewModule {}
