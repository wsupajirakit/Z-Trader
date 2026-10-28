import {
    applyDecorators,
    CallHandler,
    ExecutionContext,
    HttpException,
    Injectable,
    NestInterceptor,
    SetMetadata,
    UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, Observable, throwError } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import { AuditService } from '../../audit/audit.service';
import { clientIp } from '../../common/http/client-info';
import { errorMessage } from '../../common/utils/errors';

const MACHINE_AUDIT = 'gold:machineAudit';
/** bodies bigger than this are not copied into the audit log, only their size */
const MAX_BODY_JSON = 4096;

interface MachineAuditSpec {
    action: string;
    /** body field whose value becomes the audit `target` (mode, id, uuid, ...) */
    targetField?: string;
}

/**
 * The username zTraderActor forwards for a write it proxies on behalf of a signed-in user. It is
 * informational only (the API key is what authenticates), so it is reduced to a safe token:
 * lower-case `[a-z0-9._-]`, at most 64 characters. Anything else is dropped.
 */
export function actorUserFrom(raw: unknown): string | null {
    const v = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    if (typeof v !== 'string') return null;
    const clean = v
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 64);
    return clean || null;
}

function bodyDetail(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    let size: number;
    try {
        size = JSON.stringify(body).length;
    } catch {
        return { body_omitted: 'unserialisable' };
    }
    return size > MAX_BODY_JSON ? { body_omitted: `${size} bytes` } : { ...(body as Record<string, unknown>) };
}

function failureText(e: unknown): string {
    if (e instanceof HttpException) {
        const res = e.getResponse();
        const msg = typeof res === 'string' ? res : (res as { message?: unknown }).message;
        const text = Array.isArray(msg) ? msg.map(String).join('; ') : typeof msg === 'string' ? msg : e.message;
        return text.slice(0, 500);
    }
    return errorMessage(e).slice(0, 500);
}

/**
 * Writes one audit event per call of a machine-API write route (x-api-key), success or failure,
 * including validation failures: actor is null, `detail.via = 'api-key'`, and `detail.actorUser`
 * carries the `X-Actor-User` header when zTraderActor sends it.
 */
@Injectable()
export class MachineAuditInterceptor implements NestInterceptor {
    constructor(
        private readonly reflector: Reflector,
        private readonly audit: AuditService,
    ) {}

    intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
        const spec = this.reflector.get<MachineAuditSpec | undefined>(MACHINE_AUDIT, ctx.getHandler());
        if (!spec) return next.handle();
        const req = ctx.switchToHttp().getRequest<Request>();
        const body = bodyDetail(req.body);
        const actorUser = actorUserFrom(req.headers['x-actor-user']);
        const rawTarget = spec.targetField ? body[spec.targetField] : undefined;
        const base = {
            actor: null,
            action: spec.action,
            target: typeof rawTarget === 'string' ? rawTarget.slice(0, 100) : null,
            ip: clientIp(req),
            detail: { ...body, via: 'api-key', ...(actorUser ? { actorUser } : {}) } as Record<string, unknown>,
        };
        return next.handle().pipe(
            mergeMap((result) => from(this.audit.record({ ...base, success: true })).pipe(map(() => result))),
            catchError((e: unknown) =>
                from(
                    this.audit.record({ ...base, success: false, detail: { ...base.detail, error: failureText(e) } }),
                ).pipe(mergeMap(() => throwError(() => e))),
            ),
        );
    }
}

/** audit this machine write route (see MachineAuditInterceptor) */
export const MachineAudited = (action: string, targetField?: string) =>
    applyDecorators(
        SetMetadata(MACHINE_AUDIT, { action, targetField } satisfies MachineAuditSpec),
        UseInterceptors(MachineAuditInterceptor),
    );
