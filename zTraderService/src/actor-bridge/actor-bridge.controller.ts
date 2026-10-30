import { Body, Controller, Get, Logger, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { CurrentSession, RequireRole } from '../common/auth/auth.decorators';
import type { SessionPrincipal } from '../common/auth/principal';
import { clientIp } from '../common/http/client-info';
import { errorMessage } from '../common/utils/errors';
import { toHttpError } from '../gold/http/http-errors';
import { ActorBridgeService } from './actor-bridge.service';
import { ActorLogsQuery, ActorStartDto } from './dto/actor-bridge.dto';

/**
 * The dashboard's view of zTraderActor's legacy Sonic/Scalper loop. Session auth (global guard):
 * reads need any signed-in user, start/stop need operator plus the CSRF token, and are audited.
 */
@Controller('api/actor')
export class ActorBridgeController {
    private readonly logger = new Logger(ActorBridgeController.name);

    constructor(
        private readonly bridge: ActorBridgeService,
        private readonly audit: AuditService,
    ) {}

    @Get('state')
    state(@CurrentSession() s: SessionPrincipal) {
        return this.bridge.state(s.user.username);
    }

    @Get('logs')
    logs(@CurrentSession() s: SessionPrincipal, @Query() q: ActorLogsQuery) {
        return this.bridge.logs(s.user.username, q.after, q.limit);
    }

    @Post('start')
    @RequireRole('operator')
    start(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: ActorStartDto) {
        const detail = { symbols: body.symbols, mode: body.mode };
        return this.act(s, req, 'actor.start', body.symbols.join(','), detail, () =>
            this.bridge.start(s.user.username, body.symbols, body.mode),
        );
    }

    @Post('stop')
    @RequireRole('operator')
    stop(@CurrentSession() s: SessionPrincipal, @Req() req: Request) {
        return this.act(s, req, 'actor.stop', null, null, () => this.bridge.stop(s.user.username));
    }

    /** Same pattern as DashboardController.act: audit success and failure, map errors safely. */
    private async act<T>(
        s: SessionPrincipal,
        req: Request,
        action: string,
        target: string | null,
        detail: Record<string, unknown> | null,
        fn: () => Promise<T>,
    ): Promise<T> {
        const base = { actor: s.user, action, target, ip: clientIp(req), detail };
        try {
            const result = await fn();
            await this.audit.record({ ...base, success: true });
            return result;
        } catch (e) {
            await this.audit.record({ ...base, success: false, detail: { ...detail, error: errorMessage(e) } });
            throw toHttpError(e, this.logger, action);
        }
    }
}
