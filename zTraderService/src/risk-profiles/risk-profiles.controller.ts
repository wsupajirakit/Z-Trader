import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { CurrentSession, RequireRole } from '../common/auth/auth.decorators';
import type { SessionPrincipal } from '../common/auth/principal';
import { clientIp } from '../common/http/client-info';
import { errorMessage } from '../common/utils/errors';
import { toHttpError } from '../gold/http/http-errors';
import { CreateRiskProfileDto, UpdateRiskProfileDto } from './risk-profiles.dto';
import { RiskProfilesService } from './risk-profiles.service';

/**
 * Risk profiles: any signed-in user can list them; operators apply, create and edit; deleting a
 * saved profile needs admin. Every write goes to the audit log.
 */
@Controller('api/risk-profiles')
export class RiskProfilesController {
    private readonly logger = new Logger(RiskProfilesController.name);

    constructor(
        private readonly profiles: RiskProfilesService,
        private readonly audit: AuditService,
    ) {}

    @Get()
    list() {
        return this.profiles.list();
    }

    @Post()
    @RequireRole('operator')
    create(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: CreateRiskProfileDto) {
        return this.act(s, req, 'risk_profile.create', body.name, { ...body }, () =>
            this.profiles.create(body, s.user.username),
        );
    }

    @Patch(':id')
    @RequireRole('operator')
    update(
        @CurrentSession() s: SessionPrincipal,
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: UpdateRiskProfileDto,
    ) {
        return this.act(s, req, 'risk_profile.update', id, { ...body }, () =>
            this.profiles.update(id, body, s.user.username),
        );
    }

    @Delete(':id')
    @RequireRole('admin')
    remove(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Param('id') id: string) {
        return this.act(s, req, 'risk_profile.delete', id, null, () => this.profiles.remove(id));
    }

    @Post(':id/apply')
    @RequireRole('operator')
    apply(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Param('id') id: string) {
        return this.act(s, req, 'risk_profile.apply', id, null, () => this.profiles.apply(id));
    }

    private async act<T>(
        s: SessionPrincipal,
        req: Request,
        action: string,
        target: string | null,
        detail: Record<string, unknown> | null,
        fn: () => T | Promise<T>,
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
