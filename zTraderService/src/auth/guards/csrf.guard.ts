import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SKIP_CSRF, principalOf } from '../../common/auth/auth.decorators';
import { safeEqual } from '../../common/utils/safe-equal';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Two independent checks on every state-changing browser request:
 *  1. the per-session token in `X-CSRF-Token` (synchroniser token), and
 *  2. if the browser sent `Origin`, it must be this host.
 * SameSite=Strict on the cookie already stops classic CSRF. These checks cover the gaps it leaves
 * (same-site subdomains, older browsers).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(ctx: ExecutionContext): boolean {
        if (ctx.getType() !== 'http') return true;
        const req = ctx.switchToHttp().getRequest<Request>();
        if (SAFE_METHODS.has(req.method)) return true;

        const origin = req.headers.origin;
        if (origin && !sameHost(origin, req.headers.host))
            throw new ForbiddenException('Cross-origin request rejected');

        const p = principalOf(req);
        if (p?.kind !== 'session') return true; // public or API-key route
        if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [ctx.getHandler(), ctx.getClass()])) return true;

        const given = req.headers['x-csrf-token'];
        if (typeof given !== 'string' || !safeEqual(given, p.csrfToken))
            throw new ForbiddenException('Invalid CSRF token');
        return true;
    }
}

function sameHost(origin: string, host: string | undefined): boolean {
    try {
        return !!host && new URL(origin).host === host;
    } catch {
        return false;
    }
}
