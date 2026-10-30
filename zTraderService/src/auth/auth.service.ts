import {
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    OnApplicationBootstrap,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import type { SessionPrincipal } from '../common/auth/principal';
import { UserDocument } from '../users/schemas/user.schema';
import { toUserView, UsersService, type UserView } from '../users/users.service';
import { setLoginRateLimit } from './login-throttle';
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from './password';
import { SessionService } from './sessions/session.service';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60_000;

export interface ClientContext {
    ip: string;
    userAgent: string;
}

const BAD_CREDENTIALS = 'Invalid username or password';

@Injectable()
export class AuthService implements OnApplicationBootstrap {
    private readonly logger = new Logger(AuthService.name);
    /** verified against when the username does not exist, so both paths cost the same scrypt work */
    private dummyHash: Promise<string> = hashPassword('timing-equaliser-not-a-real-password');
    now: () => number = Date.now;

    constructor(
        private readonly users: UsersService,
        private readonly sessions: SessionService,
        private readonly audit: AuditService,
        private readonly config: ConfigService,
    ) {
        setLoginRateLimit(this.config.get<number>('LOGIN_RATE_LIMIT_PER_MIN'));
    }

    /** first run: create the admin named in BOOTSTRAP_ADMIN_* when there are no users at all */
    async onApplicationBootstrap() {
        const username = this.config.get<string>('BOOTSTRAP_ADMIN_USERNAME');
        const password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD');
        if (!username || !password || (await this.users.count()) > 0) return;
        const user = await this.users.create({
            username,
            name: username,
            role: 'admin',
            password,
            mustChangePassword: false,
        });
        await this.audit.record({
            actor: null,
            action: 'user.bootstrap',
            target: user.username,
            ip: 'system',
            success: true,
        });
        this.logger.warn(
            `created bootstrap admin "${user.username}" — remove BOOTSTRAP_ADMIN_* from the environment now`,
        );
    }

    /**
     * Checks a username/password pair with lockout and audit. Used by browser login and by the
     * machine verify endpoint (zTraderActor), so both apply exactly the same rules.
     *
     * Every refusal is the same 401 with the same body after the same scrypt work: unknown user, wrong
     * password, disabled user and locked account. A locked account is not told apart, so the lock
     * reveals neither that the account exists nor that it is under attack. The audit log has the reason.
     */
    async verifyCredentials(
        username: string,
        password: string,
        client: ClientContext,
        channel: 'web' | 'actor',
    ): Promise<UserDocument> {
        const action = channel === 'web' ? 'auth.login' : 'auth.verify_actor';
        const given = String(password ?? '');
        const user =
            typeof username === 'string' && username.length <= 64
                ? await this.users.findByUsernameWithHash(username)
                : null;
        const now = this.now();
        const refuse = async (audited: { action: string; reason?: string; locked?: boolean }) => {
            await this.audit.record({
                actor: user ? actorOf(user) : null,
                action: audited.action,
                ip: client.ip,
                success: false,
                detail: {
                    username: String(username ?? '').slice(0, 64),
                    ...(audited.reason ? { reason: audited.reason } : {}),
                    ...(audited.locked ? { locked: true } : {}),
                },
            });
            return new UnauthorizedException(BAD_CREDENTIALS);
        };

        if (user?.lockedUntil && user.lockedUntil.getTime() > now) {
            // the password is not checked at all while locked; the dummy verify keeps the timing equal
            await verifyPassword(given, await this.dummyHash);
            throw await refuse({ action: `${action}_locked` });
        }

        const ok = user
            ? await verifyPassword(given, user.passwordHash)
            : (await verifyPassword(given, await this.dummyHash), false);

        if (!user || !ok || user.disabled) {
            const locked = user && !ok ? await this.noteFailure(user) : false;
            throw await refuse({
                action: `${action}_failed`,
                reason: !user ? 'unknown_user' : !ok ? 'bad_password' : 'disabled',
                locked,
            });
        }

        // conditional on "not locked": a wrong password running in parallel may have locked the account
        // after the check above, and then this success must not clear the lock
        const updated = await this.users.recordLogin(
            String(user._id),
            new Date(this.now()),
            needsRehash(user.passwordHash) ? await hashPassword(given) : undefined,
        );
        if (!updated) throw await refuse({ action: `${action}_locked` });
        await this.audit.record({ actor: actorOf(updated), action, ip: client.ip, success: true });
        return updated;
    }

    /**
     * `previousToken` is the session cookie the browser already had, if any. It is revoked after the
     * credentials check and before the new session is created, so a planted cookie never survives a
     * login, and no step after session creation can fail and leave the new session orphaned.
     */
    async login(username: string, password: string, client: ClientContext, previousToken?: string | null) {
        const user = await this.verifyCredentials(username, password, client, 'web');
        if (previousToken) await this.sessions.revokeByToken(previousToken);
        const { token, session } = await this.sessions.create(String(user._id), client.ip, client.userAgent);
        return { token, user: toUserView(user), csrfToken: session.csrfToken };
    }

    async logout(token: string, principal: SessionPrincipal, client: ClientContext) {
        await this.sessions.revokeByToken(token);
        await this.audit.record({ actor: principal.user, action: 'auth.logout', ip: client.ip, success: true });
    }

    /** resolves a cookie token to the principal the guards work with; null = not signed in */
    async principalFor(token: string): Promise<SessionPrincipal | null> {
        const session = await this.sessions.resolve(token);
        if (!session) return null;
        const user = await this.users.findById(String(session.userId));
        if (!user || user.disabled) {
            await this.sessions.revokeByToken(token);
            return null;
        }
        return {
            kind: 'session',
            sessionId: session.publicId,
            csrfToken: session.csrfToken,
            user: {
                id: String(user._id),
                username: user.username,
                name: user.name,
                role: user.role,
                mustChangePassword: user.mustChangePassword,
            },
        };
    }

    async me(principal: SessionPrincipal): Promise<{ user: UserView; csrfToken: string }> {
        const user = await this.users.findById(principal.user.id);
        if (!user) throw new UnauthorizedException();
        return { user: toUserView(user), csrfToken: principal.csrfToken };
    }

    async changePassword(
        principal: SessionPrincipal,
        currentPassword: string,
        newPassword: string,
        client: ClientContext,
    ) {
        const user = await this.users.findByIdWithHash(principal.user.id);
        if (!user || !(await verifyPassword(String(currentPassword ?? ''), user.passwordHash))) {
            await this.audit.record({
                actor: principal.user,
                action: 'auth.change_password',
                ip: client.ip,
                success: false,
                detail: { reason: 'bad_current' },
            });
            throw new UnauthorizedException('Current password is incorrect');
        }
        if (currentPassword === newPassword)
            throw new HttpException('New password must differ from the current password', HttpStatus.BAD_REQUEST);
        const problem = passwordProblem(newPassword, user.username);
        if (problem) throw new HttpException(problem, HttpStatus.BAD_REQUEST);
        await this.users.setPassword(principal.user.id, newPassword, false);
        await this.sessions.revokeAllForUser(principal.user.id, principal.sessionId);
        await this.audit.record({
            actor: principal.user,
            action: 'auth.change_password',
            ip: client.ip,
            success: true,
        });
    }

    /** true when the account is locked once this failure is counted (by this request or a parallel one) */
    private async noteFailure(user: UserDocument): Promise<boolean> {
        const now = this.now();
        const lockedUntil = await this.users.recordFailedLogin(
            String(user._id),
            MAX_FAILED_LOGINS,
            new Date(now),
            new Date(now + LOCK_MS),
        );
        return !!lockedUntil && lockedUntil.getTime() > now;
    }
}

function actorOf(user: UserDocument) {
    return { id: String(user._id), username: user.username };
}
