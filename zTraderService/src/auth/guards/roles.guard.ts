import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { REQUIRED_ROLE, principalOf } from '../../common/auth/auth.decorators';
import { hasRole, type Role } from '../../common/auth/roles';

@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(ctx: ExecutionContext): boolean {
        if (ctx.getType() !== 'http') return true;
        const required = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
            ctx.getHandler(),
            ctx.getClass(),
        ]);
        if (!required) return true;
        const p = principalOf(ctx.switchToHttp().getRequest<Request>());
        if (p?.kind !== 'session' || !hasRole(p.user.role, required)) {
            throw new ForbiddenException('Insufficient permissions for this action');
        }
        return true;
    }
}
