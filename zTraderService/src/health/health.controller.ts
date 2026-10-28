import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import type { Connection } from 'mongoose';
import { Public } from '../common/auth/auth.decorators';

/** Probes for Docker/Coolify. Deliberately say nothing beyond up/down. */
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
    constructor(@InjectConnection() private readonly db: Connection) {}

    /** liveness: the process answers HTTP */
    @Get()
    live() {
        return { status: 'ok' };
    }

    /** readiness: the database is reachable */
    @Get('ready')
    async ready() {
        try {
            await this.db.db?.admin().ping();
            return { status: 'ok' };
        } catch {
            throw new ServiceUnavailableException({ status: 'unavailable' });
        }
    }
}
