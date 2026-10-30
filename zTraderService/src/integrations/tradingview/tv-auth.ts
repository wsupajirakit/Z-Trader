import { Logger } from '@nestjs/common';
import { errorMessage } from '../../common/utils/errors';

/**
 * Which token a TradingView session sends with set_auth_token (port of z-service auth.py):
 *   1. TV_USERNAME + TV_PASSWORD → sign in, keep the token in memory until it nears expiry
 *   2. TV_AUTH_TOKEN             → used as is (also the fallback when sign-in fails)
 *   3. nothing                   → anonymous ("unauthorized_user_token"), heavily rate-limited
 * A failed sign-in backs off (TradingView answers frequent sign-ins with a recaptcha wall).
 * Tokens and passwords are never logged.
 */
export interface TvAuthSettings {
    username?: string;
    password?: string;
    authToken?: string;
}

const SIGNIN_URL = 'https://www.tradingview.com/accounts/signin/';
export const TV_BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFRESH_MARGIN_MS = 10 * 60_000;
const LOGIN_BACKOFF_MS = 10 * 60_000;
const RECAPTCHA_BACKOFF_MS = 60 * 60_000;
/** a token TradingView refused is not offered again for this long */
const REJECTED_TOKEN_PAUSE_MS = 10 * 60_000;

/** `exp` of a JWT in ms, or 0 when it is not a readable JWT */
export function jwtExpiryMs(token: string): number {
    try {
        const part = token.split('.')[1];
        if (!part) return 0;
        const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
        return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
    } catch {
        return 0;
    }
}

export class TvAuth {
    private readonly logger = new Logger('TradingViewAuth');
    private loginToken: string | null = null;
    private loginExp = 0;
    private nextLoginAt = 0;
    private signingIn: Promise<string | null> | null = null;
    private staticPausedUntil = 0;

    constructor(
        private readonly settings: () => TvAuthSettings,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    get mode(): 'login' | 'token' | 'anonymous' {
        const s = this.settings();
        if (s.username && s.password) return 'login';
        if (s.authToken) return 'token';
        return 'anonymous';
    }

    /** best token right now, or null for anonymous */
    async token(): Promise<string | null> {
        const s = this.settings();
        const now = Date.now();
        if (s.username && s.password) {
            const tok = await this.loginModeToken(s.username, s.password, now);
            if (tok) return tok;
        }
        if (s.authToken && now >= this.staticPausedUntil) {
            const exp = jwtExpiryMs(s.authToken);
            if (exp === 0 || exp > now) return s.authToken;
        }
        return null;
    }

    /** TradingView refused this token: drop it and fall back for a while */
    reject(token: string): void {
        if (token === this.loginToken) {
            this.loginToken = null;
            this.loginExp = 0;
            this.logger.warn('TradingView refused the sign-in token; it will sign in again on the next session');
        } else if (token === this.settings().authToken) {
            this.staticPausedUntil = Date.now() + REJECTED_TOKEN_PAUSE_MS;
            this.logger.warn('TradingView refused TV_AUTH_TOKEN; using anonymous access for 10 minutes');
        }
    }

    private async loginModeToken(username: string, password: string, now: number): Promise<string | null> {
        if (this.loginToken && (this.loginExp === 0 || this.loginExp - now > REFRESH_MARGIN_MS)) return this.loginToken;
        if (now < this.nextLoginAt) {
            return this.loginToken && (this.loginExp === 0 || this.loginExp > now) ? this.loginToken : null;
        }
        if (!this.signingIn) {
            this.signingIn = this.signIn(username, password).finally(() => (this.signingIn = null));
        }
        return this.signingIn;
    }

    private async signIn(username: string, password: string): Promise<string | null> {
        let code: string;
        try {
            const res = await this.fetchImpl(SIGNIN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Referer: 'https://www.tradingview.com',
                    Origin: 'https://www.tradingview.com',
                    'User-Agent': TV_BROWSER_UA,
                },
                body: new URLSearchParams({ username, password, remember: 'on' }).toString(),
                signal: AbortSignal.timeout(15_000),
            });
            const body = (await res.json().catch(() => ({}))) as { user?: { auth_token?: unknown }; code?: unknown };
            const tok = body.user?.auth_token;
            if (typeof tok === 'string' && tok) {
                this.loginToken = tok;
                this.loginExp = jwtExpiryMs(tok);
                this.logger.log('TradingView sign-in succeeded');
                return tok;
            }
            code = typeof body.code === 'string' ? body.code : `http_${res.status}`;
        } catch (e) {
            code = `network (${errorMessage(e)})`;
        }
        const wait = code === 'recaptcha_required' ? RECAPTCHA_BACKOFF_MS : LOGIN_BACKOFF_MS;
        this.nextLoginAt = Date.now() + wait;
        this.logger.warn(
            `TradingView sign-in failed (${code}); falling back to ${
                this.settings().authToken ? 'TV_AUTH_TOKEN' : 'anonymous access'
            }, next attempt in ${Math.round(wait / 60_000)} min`,
        );
        return null;
    }
}
