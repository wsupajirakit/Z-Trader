import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ActorBridgeModule } from './actor-bridge/actor-bridge.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/guards/auth.guard';
import { ChartModule } from './chart/chart.module';
import { CsrfGuard } from './auth/guards/csrf.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { validateEnv } from './config/env.validation';
import { CtraderModule } from './ctrader/ctrader.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { RiskProfilesModule } from './risk-profiles/risk-profiles.module';
import { ExecutionModule } from './execution/execution.module';
import { GoldModule } from './gold/gold.module';
import { HealthModule } from './health/health.module';
import { KlinesModule } from './klines/klines.module';
import { OrdersModule } from './orders/orders.module';
import { TelegramModule } from './telegram/telegram.module';
import { UsersModule } from './users/users.module';

@Module({
    imports: [
        // tests must never pick up a developer's .env (real broker token, Telegram bot)
        ConfigModule.forRoot({
            isGlobal: true,
            cache: true,
            validate: validateEnv,
            ignoreEnvFile: process.env.NODE_ENV === 'test',
        }),
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                uri: config.getOrThrow<string>('MONGO_URI'),
                serverSelectionTimeoutMS: 10_000,
            }),
        }),
        // per-IP budget for every route (dashboard polling included); login has its own stricter limit
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }] }),
        EventEmitterModule.forRoot(),

        // platform
        HealthModule,
        AuditModule,
        UsersModule,
        AuthModule,

        // trading
        CtraderModule,
        OrdersModule,
        ExecutionModule,
        TelegramModule,
        KlinesModule,
        GoldModule,
        DashboardModule,
        RiskProfilesModule,
        ActorBridgeModule,
        ChartModule,
    ],
    providers: [
        // global guards run in this order: rate limit → identify (session / API key) → CSRF → role
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
    ],
})
export class AppModule {}
