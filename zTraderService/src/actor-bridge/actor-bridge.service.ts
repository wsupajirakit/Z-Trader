import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/utils/errors';
import { demoContext } from '../common/demo/demo-context';

export const ACTOR_TIMEOUT_MS = 5_000;

/** Why the Actor cannot be used right now. Shown to the user as-is. */
export const ACTOR_NOT_CONFIGURED = 'ACTOR_URL is not configured';
export const ACTOR_UNREACHABLE = 'Actor unreachable';
export const ACTOR_REJECTED_KEY = 'Actor rejected the API key';
export type ActorUnavailableReason = typeof ACTOR_NOT_CONFIGURED | typeof ACTOR_UNREACHABLE | typeof ACTOR_REJECTED_KEY;

export interface ActorUnavailable {
    available: false;
    reason: ActorUnavailableReason;
}

export interface ActorLiveSymbol {
    symbol: string;
    price: number | null;
    rsi: number | null;
    ema: number | null;
    lastUpdate: string | null;
    hasReceived: boolean;
}

export interface ActorEngine {
    isRunning: boolean;
    symbols: string[];
    mode: string;
    maxPositions: number;
    modes: string[];
    symbolsLive: ActorLiveSymbol[];
}

export interface ActorLogEntry {
    id: number;
    ts: string;
    type: string;
    message: string;
    channel: 'order' | 'system';
}

export interface ActorLogs {
    latestId: number;
    entries: ActorLogEntry[];
}

export interface ActorActionResult {
    ok: true;
    state: { isRunning: boolean; symbols: string[]; mode: string };
}

type Upstream =
    { kind: 'response'; status: number; body: unknown } | { kind: 'unavailable'; reason: ActorUnavailableReason };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** HttpException whose body carries both `error` (bridge contract) and `message` (Nest convention). */
function bridgeError(status: number, text: string): HttpException {
    return new HttpException({ statusCode: status, error: text, message: text }, status);
}

/**
 * Talks to zTraderActor's machine API (`/api/machine/*`, x-api-key). The Actor is a separate,
 * optional process: reads never fail because of it (they report `available: false` with a reason),
 * writes fail with 502/503 so the operator sees that nothing happened.
 */
@Injectable()
export class ActorBridgeService {
    private readonly logger = new Logger(ActorBridgeService.name);
    private readonly baseUrl: string | null;
    private readonly apiKey: string;
    /** last connection problem logged, so a dashboard polling a stopped Actor logs once, not every poll */
    private lastProblem: string | null = null;

    constructor(config: ConfigService) {
        this.baseUrl = config.get<string>('ACTOR_URL') || null;
        this.apiKey = config.get<string>('API_KEY', '');
    }

    async state(user: string): Promise<({ available: true } & ActorEngine) | ActorUnavailable> {
        const up = await this.call('GET', '/api/machine/engine', { user });
        if (up.kind === 'unavailable') return { available: false, reason: up.reason };
        if (up.status !== 200 || !isObject(up.body)) return this.unexpected('GET engine', up);
        return { available: true, ...(up.body as unknown as ActorEngine) };
    }

    async logs(user: string, after: number, limit: number): Promise<ActorLogs | ActorUnavailable> {
        const query = new URLSearchParams({ after: String(after), limit: String(limit) });
        const up = await this.call('GET', `/api/machine/logs?${query.toString()}`, { user });
        if (up.kind === 'unavailable') return { available: false, reason: up.reason };
        if (up.status !== 200 || !isObject(up.body)) return this.unexpected('GET logs', up);
        return up.body as unknown as ActorLogs;
    }

    start(user: string, symbols: string[], mode: string): Promise<ActorActionResult> {
        return this.act(user, '/api/machine/engine/start', { symbols, mode });
    }

    stop(user: string): Promise<ActorActionResult> {
        return this.act(user, '/api/machine/engine/stop', {});
    }

    private async act(user: string, path: string, body: Record<string, unknown>): Promise<ActorActionResult> {
        demoContext.assertNotDemo('Starting or stopping the strategy loop');
        const up = await this.call('POST', path, { user, body });
        if (up.kind === 'unavailable') {
            throw bridgeError(
                up.reason === ACTOR_NOT_CONFIGURED ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY,
                up.reason,
            );
        }
        if (up.status === 200 && isObject(up.body)) return up.body as unknown as ActorActionResult;
        if (up.status === 400) {
            const raw = isObject(up.body) && typeof up.body.error === 'string' ? up.body.error : 'rejected by Actor';
            throw bridgeError(HttpStatus.BAD_REQUEST, raw.slice(0, 300));
        }
        this.logger.error(`POST ${path}: Actor answered ${up.status}`);
        throw bridgeError(HttpStatus.BAD_GATEWAY, ACTOR_UNREACHABLE);
    }

    private unexpected(context: string, up: { status: number }): ActorUnavailable {
        this.logger.warn(`${context}: Actor answered ${up.status} with an unexpected body`);
        return { available: false, reason: ACTOR_UNREACHABLE };
    }

    private problem(text: string) {
        if (text === this.lastProblem) return;
        this.lastProblem = text;
        this.logger.warn(text);
    }

    private async call(
        method: 'GET' | 'POST',
        path: string,
        { user, body }: { user: string; body?: Record<string, unknown> },
    ): Promise<Upstream> {
        if (!this.baseUrl) return { kind: 'unavailable', reason: ACTOR_NOT_CONFIGURED };
        const headers: Record<string, string> = {
            accept: 'application/json',
            'x-api-key': this.apiKey,
            'x-actor-user': user,
        };
        if (body !== undefined) headers['content-type'] = 'application/json';
        let res: Response;
        let text: string;
        try {
            res = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'error',
                signal: AbortSignal.timeout(ACTOR_TIMEOUT_MS),
            });
            text = await res.text();
        } catch (e) {
            this.problem(`${method} ${path}: ${ACTOR_UNREACHABLE} (${errorMessage(e)})`);
            return { kind: 'unavailable', reason: ACTOR_UNREACHABLE };
        }
        if (res.status === 401 || res.status === 403) {
            this.problem(`${method} ${path}: Actor answered ${res.status} (check that API_KEY matches on both sides)`);
            return { kind: 'unavailable', reason: ACTOR_REJECTED_KEY };
        }
        if (this.lastProblem) {
            this.logger.log('Actor reachable again');
            this.lastProblem = null;
        }
        let parsed: unknown;
        try {
            parsed = text ? JSON.parse(text) : undefined;
        } catch {
            this.logger.warn(`${method} ${path}: Actor answered ${res.status} with a non-JSON body`);
            return { kind: 'unavailable', reason: ACTOR_UNREACHABLE };
        }
        return { kind: 'response', status: res.status, body: parsed };
    }
}
