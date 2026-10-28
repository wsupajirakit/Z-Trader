import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ALLOW_PENDING_PASSWORD, API_KEY_AUTH, IS_PUBLIC } from '../../common/auth/auth.decorators';
import type { Principal } from '../../common/auth/principal';
import { safeEqual } from '../../common/utils/safe-equal';
import { AuthService } from '../auth.service';
import { readSessionToken, type SecureSetting } from '../session-cookie';

export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

/**
 * Global and secure by default: every HTTP route needs a browser session unless it is marked
 * `@Public()` or `@ApiKeyAuth()`. The two schemes never stand in for each other, so a leaked API key
 * cannot drive the dashboard API, and a browser session cannot call the machine API.
 */
@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly auth: AuthService,
        private readonly config: ConfigService,
    ) {}

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        if (ctx.getType() !== 'http') return true; // socket.io authenticates in its own middleware
        const flag = (key: string) =>
            this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]);
        const req = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();

        if (flag(IS_PUBLIC)) return true;

        if (flag(API_KEY_AUTH)) {
            const expected = this.config.get<string>('API_KEY', '');
            const given = req.headers['x-api-key'];
            if (!expected || typeof given !== 'string' || !safeEqual(given, expected)) {
                throw new UnauthorizedException('Invalid API key');
            }
            req.principal = { kind: 'apiKey' };
            return true;
        }

        const token = readSessionToken(req, this.config.get<SecureSetting>('SESSION_COOKIE_SECURE', 'auto'));
        const principal = token ? await this.auth.principalFor(token) : null;
        if (!principal) throw new UnauthorizedException('ต้องเข้าสู่ระบบก่อน');
        if (principal.user.mustChangePassword && !flag(ALLOW_PENDING_PASSWORD)) {
            throw new ForbiddenException(PASSWORD_CHANGE_REQUIRED);
        }
        req.principal = principal;
        return true;
    }
}
