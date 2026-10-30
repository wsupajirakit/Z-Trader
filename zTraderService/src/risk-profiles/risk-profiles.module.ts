import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountModule } from '../account/account.module';
import { AuditModule } from '../audit/audit.module';
import { GoldModule } from '../gold/gold.module';
import { RiskProfilesController } from './risk-profiles.controller';
import { RiskProfilesService } from './risk-profiles.service';
import { RiskProfile, RiskProfileSchema } from './schemas/risk-profile.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: RiskProfile.name, schema: RiskProfileSchema }]),
        GoldModule,
        AccountModule,
        AuditModule,
    ],
    controllers: [RiskProfilesController],
    providers: [RiskProfilesService],
})
export class RiskProfilesModule {}
