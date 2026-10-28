import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Session, SessionSchema } from './session.schema';
import { SessionService } from './session.service';

/** session storage only — no user logic, so both AuthModule and UsersModule can depend on it */
@Module({
    imports: [MongooseModule.forFeature([{ name: Session.name, schema: SessionSchema }])],
    providers: [SessionService],
    exports: [SessionService],
})
export class SessionsModule {}
