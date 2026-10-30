import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { UserIdParam } from '../users/dto/user.dto';
import { UsersService } from '../users/users.service';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AllowPendingPassword, ApiKeyAuth, CurrentSession, Public, SkipCsrf } from '../common/auth/auth.decorators';
import type { SessionPrincipal } from '../common/auth/principal';
import { clientIp, userAgent } from '../common/http/client-info';
import { toUserView } from '../users/users.service';
import { AuthService } from './auth.service';
import { LOGIN_THROTTLE, VERIFY_THROTTLE } from './login-throttle';
import { ChangePasswordDto, LoginDto, SessionIdParam, VerifyCredentialsDto } from './dto/auth.dto';
import { clearSessionCookie, readSessionToken, writeSessionCookie, type SecureSetting } from './session-cookie';
import { SessionService } from './sessions/session.service';

@Controller('api/auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly sessions: SessionService,
        private readonly config: ConfigService,
    ) {}

    @Post('login')
    @Public()
    @SkipCsrf()
    @HttpCode(200)
    @Throttle(LOGIN_THROTTLE)
    async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
        const secure = this.config.get<SecureSetting>('SESSION_COOKIE_SECURE', 'auto');
        // a token from before login (if any) is revoked before the new session exists, so a planted cookie
        // cannot become an authenticated session, and nothing after session creation can fail and orphan it
        const result = await this.auth.login(
            body.username,
            body.password,
            { ip: clientIp(req), userAgent: userAgent(req) },
            readSessionToken(req, secure),
        );
        writeSessionCookie(res, req, result.token, secure);
        return { user: result.user, csrfToken: result.csrfToken };
    }

    @Post('logout')
    @AllowPendingPassword()
    @HttpCode(204)
    async logout(
        @CurrentSession() p: SessionPrincipal,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        const token = readSessionToken(req, this.config.get<SecureSetting>('SESSION_COOKIE_SECURE', 'auto'));
        if (token) await this.auth.logout(token, p, { ip: clientIp(req), userAgent: userAgent(req) });
        clearSessionCookie(res);
    }

    @Get('me')
    @AllowPendingPassword()
    me(@CurrentSession() p: SessionPrincipal) {
        return this.auth.me(p);
    }

    @Post('change-password')
    @AllowPendingPassword()
    @HttpCode(204)
    @Throttle(LOGIN_THROTTLE)
    async changePassword(@CurrentSession() p: SessionPrincipal, @Body() body: ChangePasswordDto, @Req() req: Request) {
        await this.auth.changePassword(p, body.currentPassword, body.newPassword, {
            ip: clientIp(req),
            userAgent: userAgent(req),
        });
    }

    @Get('sessions')
    sessionsList(@CurrentSession() p: SessionPrincipal) {
        return this.sessions.listForUser(p.user.id, p.sessionId);
    }

    @Delete('sessions/:id')
    @HttpCode(204)
    async revoke(@CurrentSession() p: SessionPrincipal, @Param() { id }: SessionIdParam) {
        if (!(await this.sessions.revokeOwn(p.user.id, id))) throw new NotFoundException('Session not found');
    }

    @Post('sessions/revoke-others')
    @HttpCode(204)
    async revokeOthers(@CurrentSession() p: SessionPrincipal) {
        await this.sessions.revokeAllForUser(p.user.id, p.sessionId);
    }
}

/** service-to-service: zTraderActor checks its users' credentials here instead of keeping its own copy */
@Controller('api/v1/auth')
@ApiKeyAuth()
export class MachineAuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly users: UsersService,
    ) {}

    /**
     * zTraderActor re-checks its signed-in users here, so a disable, role change or password reset made
     * on the main dashboard reaches the Actor's sessions too. A disabled or unknown user is a 404.
     */
    @Get('users/:id')
    async user(@Param() { id }: UserIdParam) {
        const user = await this.users.findById(id);
        if (!user || user.disabled) throw new NotFoundException();
        return { user: toUserView(user), passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null };
    }

    /** a locked account answers 401 exactly like a bad password; 429 only ever comes from the throttle */
    @Post('verify')
    @HttpCode(200)
    @Throttle(VERIFY_THROTTLE)
    async verify(@Body() body: VerifyCredentialsDto, @Req() req: Request) {
        const ip = body.clientIp ? `${body.clientIp} via actor` : clientIp(req);
        const user = await this.auth.verifyCredentials(
            body.username,
            body.password,
            { ip, userAgent: body.userAgent ?? '' },
            'actor',
        );
        return { user: toUserView(user) };
    }
}
