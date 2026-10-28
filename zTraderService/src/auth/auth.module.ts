import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { UsersModule } from '../users/users.module';
import { AuthController, MachineAuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionsModule } from './sessions/sessions.module';

@Module({
    imports: [UsersModule, SessionsModule, AuditModule],
    controllers: [AuthController, MachineAuthController],
    // the guards are registered globally in AppModule, where their order is visible
    providers: [AuthService],
    exports: [AuthService],
})
export class AuthModule {}
