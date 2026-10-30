import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CtraderModule } from '../ctrader/ctrader.module';
import { ExecutionModule } from '../execution/execution.module';
import { OrdersModule } from '../orders/orders.module';
import { TelegramModule } from '../telegram/telegram.module';
import { GoldDataService } from './data/gold-data.service';
import { GoldBuilderService } from './data/gold-builder.service';
import { GoldAiService } from './ai/gold-ai.service';
import { GoldGeminiService } from './ai/gold-gemini.service';
import { GoldInstrumentService } from './gold-instrument.service';
import { GoldTaService } from './analysis/gold-ta.service';
import { GoldArchiveService } from './records/gold-archive.service';
import { GoldHistoryService } from './records/gold-history.service';
import { GoldActivityService } from './records/gold-activity.service';
import { DealCacheService } from './records/deal-cache.service';
import { GoldAutomateService } from './gold-automate.service';
import { GoldController } from './gold.controller';

@Module({
    imports: [CtraderModule, ExecutionModule, OrdersModule, TelegramModule, AuditModule],
    providers: [
        GoldDataService,
        GoldBuilderService,
        GoldAiService,
        GoldGeminiService,
        GoldInstrumentService,
        GoldTaService,
        GoldArchiveService,
        GoldHistoryService,
        GoldActivityService,
        DealCacheService,
        GoldAutomateService,
    ],
    controllers: [GoldController],
    // dashboard (รวมอยู่ใน service เดียวกัน) เรียกใช้ service เหล่านี้ตรง ๆ
    exports: [
        GoldAutomateService,
        GoldBuilderService,
        GoldArchiveService,
        GoldHistoryService,
        GoldActivityService,
        GoldInstrumentService,
    ],
})
export class GoldModule {}
