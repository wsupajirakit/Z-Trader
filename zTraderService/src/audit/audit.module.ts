import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditEvent, AuditEventSchema } from './schemas/audit-event.schema';

@Module({
    imports: [MongooseModule.forFeature([{ name: AuditEvent.name, schema: AuditEventSchema }])],
    controllers: [AuditController],
    providers: [AuditService],
    exports: [AuditService],
})
export class AuditModule {}
