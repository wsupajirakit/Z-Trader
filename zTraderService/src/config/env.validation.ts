import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    Min,
    MinLength,
    validateSync,
} from 'class-validator';

/**
 * Only the settings that decide whether the service is safe to start are validated here. The many
 * GOLD_* / FX_* knobs keep their defaults inside the services that read them.
 */
export class EnvironmentVariables {
    @IsIn(['development', 'production', 'test'])
    NODE_ENV: 'development' | 'production' | 'test' = 'development';

    @IsInt()
    @Min(1)
    @Max(65535)
    PORT = 6500;

    @IsString()
    @Matches(/^mongodb(\+srv)?:\/\//, { message: 'MONGO_URI must start with mongodb:// or mongodb+srv://' })
    MONGO_URI!: string;

    /** machine-to-machine key (zTraderActor, the /gold-run skill). Never accepted by the dashboard API. */
    @IsString()
    @MinLength(32, { message: 'API_KEY must be at least 32 characters (openssl rand -hex 32)' })
    API_KEY!: string;

    @IsIn(['DEMO', 'LIVE'])
    CTRADER_ACCOUNT_MODE: 'DEMO' | 'LIVE' = 'DEMO';

    /** second key for LIVE: CTRADER_ACCOUNT_MODE=LIVE alone refuses to boot */
    @IsBoolean()
    CTRADER_ALLOW_LIVE = false;

    /** number of reverse-proxy hops in front of the app (Coolify/Traefik = 1). 0 = trust nothing. */
    @IsInt()
    @Min(0)
    @Max(5)
    TRUST_PROXY = 0;

    @IsIn(['auto', 'true', 'false'])
    SESSION_COOKIE_SECURE: 'auto' | 'true' | 'false' = 'auto';

    @IsString()
    WEB_DIST_DIR = './web/dist';

    @IsInt()
    @Min(1)
    @Max(1000)
    LOGIN_RATE_LIMIT_PER_MIN = 10;

    /** first-run only: creates this admin when the users collection is empty */
    @IsOptional()
    @IsString()
    @Matches(/^[a-z0-9._-]{3,32}$/, { message: 'BOOTSTRAP_ADMIN_USERNAME must be 3–32 chars of a-z 0-9 . _ -' })
    BOOTSTRAP_ADMIN_USERNAME?: string;

    @IsOptional()
    @IsString()
    @MinLength(9)
    BOOTSTRAP_ADMIN_PASSWORD?: string;

    /**
     * base URL of zTraderActor (the legacy Sonic/Scalper loop), e.g. http://localhost:3000. Unset = the
     * dashboard's Actor panel reports "not configured". Checked to be an absolute http(s) URL below.
     */
    @IsOptional()
    @IsString()
    ACTOR_URL?: string;
}

const BOOL = new Set(['true', '1', 'yes']);

/**
 * The only hosts the broker credentials (APP_ID/APP_SECRET/ACCESS_TOKEN) may be sent to. CTRADER_HOST
 * exists so the tests can point the client at a closed local port. Anywhere else, an override would let
 * whoever can set one variable collect the broker token.
 */
const CTRADER_HOSTS = new Set(['demo.ctraderapi.com', 'live.ctraderapi.com']);

export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
    const input = { ...raw };
    for (const k of ['CTRADER_ALLOW_LIVE']) {
        if (typeof input[k] === 'string') input[k] = BOOL.has(String(input[k]).toLowerCase());
    }
    for (const k of ['PORT', 'TRUST_PROXY', 'LOGIN_RATE_LIMIT_PER_MIN']) {
        if (input[k] === '' || input[k] === undefined) delete input[k];
        else input[k] = Number(input[k]);
    }
    for (const k of ['BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_PASSWORD']) {
        if (input[k] === '') delete input[k];
    }
    // a key pasted with a trailing newline or space must still meet the length rule on its real value
    if (typeof input.API_KEY === 'string') input.API_KEY = input.API_KEY.trim();
    if (typeof input.ACTOR_URL === 'string') {
        input.ACTOR_URL = input.ACTOR_URL.trim().replace(/\/+$/, '');
        if (input.ACTOR_URL === '') delete input.ACTOR_URL;
    }
    if (typeof input.CTRADER_HOST === 'string') {
        input.CTRADER_HOST = input.CTRADER_HOST.trim().toLowerCase();
        if (input.CTRADER_HOST === '') delete input.CTRADER_HOST;
    }
    if (typeof input.CTRADER_ACCOUNT_MODE === 'string')
        input.CTRADER_ACCOUNT_MODE = input.CTRADER_ACCOUNT_MODE.toUpperCase();

    const env = plainToInstance(EnvironmentVariables, input, { exposeDefaultValues: true });
    const errors = validateSync(env, { skipMissingProperties: false });
    const problems = errors.flatMap((e) => Object.values(e.constraints ?? {}));

    if (env.CTRADER_ACCOUNT_MODE === 'LIVE' && !env.CTRADER_ALLOW_LIVE) {
        problems.push('CTRADER_ACCOUNT_MODE=LIVE also requires CTRADER_ALLOW_LIVE=true (real money safety interlock)');
    }
    if (!!env.BOOTSTRAP_ADMIN_USERNAME !== !!env.BOOTSTRAP_ADMIN_PASSWORD) {
        problems.push('BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must be set together');
    }
    if (env.ACTOR_URL !== undefined && !isHttpUrl(env.ACTOR_URL)) {
        problems.push('ACTOR_URL must be an absolute http(s) URL, e.g. http://localhost:3000 (or unset)');
    }
    const host = input.CTRADER_HOST;
    if (host !== undefined && env.NODE_ENV !== 'test' && !(typeof host === 'string' && CTRADER_HOSTS.has(host))) {
        // the value itself is not echoed: a mistyped secret pasted into the wrong variable must not reach the log
        problems.push(
            `CTRADER_HOST may only be ${[...CTRADER_HOSTS].join(' or ')} (unset = chosen by CTRADER_ACCOUNT_MODE)`,
        );
    }
    if (problems.length) {
        throw new Error(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
    }
    if (env.NODE_ENV === 'production' && env.SESSION_COOKIE_SECURE === 'auto' && env.TRUST_PROXY === 0) {
        // not fatal: docker compose on a LAN over plain HTTP is a legitimate production-mode run
        new Logger('Config').warn(
            '!!! NODE_ENV=production with SESSION_COOKIE_SECURE=auto and TRUST_PROXY=0: the app cannot see that ' +
                'the proxy in front speaks HTTPS, so session cookies are issued WITHOUT Secure and without the ' +
                '__Host- prefix. Behind Coolify/Traefik set TRUST_PROXY=1 (or SESSION_COOKIE_SECURE=true). ' +
                'Ignore this only for a plain-HTTP run on a trusted network.',
        );
    }
    // keep every other variable (GOLD_*, FX_*, …) available through ConfigService; the normalised values win
    return { ...raw, ...env };
}

function isHttpUrl(value: string): boolean {
    try {
        const u = new URL(value);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
    } catch {
        return false;
    }
}
