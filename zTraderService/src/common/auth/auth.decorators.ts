import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Role } from './roles';
import type { Principal, SessionPrincipal } from './principal';

export const IS_PUBLIC = 'auth:public';
export const API_KEY_AUTH = 'auth:apiKey';
export const REQUIRED_ROLE = 'auth:role';
export const ALLOW_PENDING_PASSWORD = 'auth:allowPendingPassword';
export const SKIP_CSRF = 'auth:skipCsrf';

/** no authentication at all (health probe, login) */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** machine-to-machine route: `x-api-key` only, browser sessions are refused */
export const ApiKeyAuth = () => SetMetadata(API_KEY_AUTH, true);

/** minimum role for a session route (default: any signed-in user = viewer) */
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE, role);

/** reachable while the user still has to change a temporary password */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

/** the request carries no session yet (login), so there is no CSRF token to check */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

export function principalOf(req: Request): Principal | undefined {
    return (req as Request & { principal?: Principal }).principal;
}

/** the signed-in user of a session route — only valid behind the global AuthGuard */
export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionPrincipal => {
    const p = principalOf(ctx.switchToHttp().getRequest<Request>());
    if (p?.kind !== 'session') throw new Error('CurrentSession used on a route without a session principal');
    return p;
});
