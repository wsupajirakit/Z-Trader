import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/sessions/session.service';
import { CurrentSession, RequireRole } from '../common/auth/auth.decorators';
import type { SessionPrincipal } from '../common/auth/principal';
import { clientIp } from '../common/http/client-info';
import { CreateUserDto, ResetPasswordDto, UpdateUserDto, UserIdParam } from './dto/user.dto';
import { toUserView, UsersService } from './users.service';

@Controller('api/users')
@RequireRole('admin')
export class UsersController {
    constructor(
        private readonly users: UsersService,
        private readonly sessions: SessionService,
        private readonly audit: AuditService,
    ) {}

    @Get()
    async list() {
        return (await this.users.list()).map(toUserView);
    }

    @Post()
    async create(@CurrentSession() p: SessionPrincipal, @Body() body: CreateUserDto, @Req() req: Request) {
        const user = await this.users.create({ ...body, mustChangePassword: true });
        await this.audit.record({
            actor: p.user,
            action: 'user.create',
            target: user.username,
            ip: clientIp(req),
            success: true,
            detail: { role: user.role },
        });
        return toUserView(user);
    }

    @Patch(':id')
    async update(
        @CurrentSession() p: SessionPrincipal,
        @Param() { id }: UserIdParam,
        @Body() body: UpdateUserDto,
        @Req() req: Request,
    ) {
        const { before, after: user } = await this.users.update(p.user.id, id, body);
        // a role change or a disable takes effect now, not when the old session would have expired
        if (before.role !== user.role || (!before.disabled && user.disabled)) {
            await this.sessions.revokeAllForUser(id);
        }
        await this.audit.record({
            actor: p.user,
            action: 'user.update',
            target: user.username,
            ip: clientIp(req),
            success: true,
            detail: { ...body },
        });
        return toUserView(user);
    }

    @Post(':id/reset-password')
    @HttpCode(204)
    async resetPassword(
        @CurrentSession() p: SessionPrincipal,
        @Param() { id }: UserIdParam,
        @Body() body: ResetPasswordDto,
        @Req() req: Request,
    ) {
        const user = await this.users.setPassword(id, body.password, true);
        await this.sessions.revokeAllForUser(id);
        await this.audit.record({
            actor: p.user,
            action: 'user.reset_password',
            target: user.username,
            ip: clientIp(req),
            success: true,
        });
    }
}
