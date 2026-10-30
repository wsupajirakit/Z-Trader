import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ActorBridgeController } from './actor-bridge.controller';
import { ActorBridgeService } from './actor-bridge.service';

/** Session-authenticated proxy from the dashboard to zTraderActor's machine API (ACTOR_URL). */
@Module({
    imports: [AuditModule],
    controllers: [ActorBridgeController],
    providers: [ActorBridgeService],
})
export class ActorBridgeModule {}
