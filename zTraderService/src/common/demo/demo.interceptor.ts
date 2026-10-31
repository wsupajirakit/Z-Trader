import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, from } from 'rxjs';
import { AuditService } from '../../audit/audit.service';
import { principalOf } from '../auth/auth.decorators';
import { clientIp } from '../http/client-info';
import { demoContext } from './demo-context';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** writes a demo user may really perform: their own account only */
const OWN_ACCOUNT = [
    /^POST \/api\/auth\/logout$/,
    /^POST \/api\/auth\/change-password$/,
    /^DELETE \/api\/auth\/sessions\/[^/]+$/,
    /^POST \/api\/auth\/sessions\/revoke-others$/,
];

/** analysis rounds: run for real in the sandbox (no order, no AI call, no shared state) */
const SANDBOXED = [/^POST \/api\/dashboard\/(run|analyze)$/];

export const DEMO_SIMULATED_MESSAGE = 'Demo role: the action was simulated — nothing was changed, sent or saved';

/**
 * Demo sessions: reads run normally; the user's own account actions run normally; analysis rounds run
 * in the sandbox; EVERY other write (settings, risk profiles, loop start/stop, instrument, firing a
 * decision, daily-stop reset, users, the strategy loop, and any route added later) is answered with a
 * simulated success without calling the handler. Default-deny: a new route is simulated until it is
 * explicitly listed above. Everything runs inside demoContext, so the guards at the broker, AI and
 * notification boundaries also apply.
 */
@Injectable()
export class DemoInterceptor implements NestInterceptor {
    private readonly logger = new Logger(DemoInterceptor.name);

    constructor(private readonly audit: AuditService) {}

    intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (ctx.getType() !== 'http') return next.handle();
        const req = ctx.switchToHttp().getRequest<Request>();
        const p = principalOf(req);
        if (p?.kind !== 'session' || p.user.role !== 'demo') return next.handle();

        const username = p.user.username;
        const key = `${req.method} ${req.path}`;
        const runsForReal =
            READS.has(req.method) || OWN_ACCOUNT.some((r) => r.test(key)) || SANDBOXED.some((r) => r.test(key));
        if (runsForReal) {
            return new Observable((subscriber) => demoContext.run(username, () => next.handle().subscribe(subscriber)));
        }

        this.logger.log(`demo user "${username}": simulated ${key}`);
        const recorded = this.audit
            .record({
                actor: p.user,
                action: 'demo.simulated',
                target: key,
                ip: clientIp(req),
                detail: null,
                success: true,
            })
            .catch(() => undefined);
        return from(recorded.then(() => ({ demo: true, simulated: true, message: DEMO_SIMULATED_MESSAGE })));
    }
}
