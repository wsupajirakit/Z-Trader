import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { errorMessage } from '../common/utils/errors';
import { AuditEvent, AuditEventDocument } from './schemas/audit-event.schema';

export interface AuditActor {
    id: string;
    username: string;
}

export interface AuditEntry {
    actor: AuditActor | null;
    action: string;
    target?: string | null;
    ip: string;
    success: boolean;
    detail?: Record<string, unknown> | null;
}

export interface AuditEventView {
    id: string;
    at: string;
    actor: AuditActor | null;
    action: string;
    target: string | null;
    ip: string;
    success: boolean;
    detail: Record<string, unknown> | null;
}

/** Keys that must never be written to the audit log, whatever the caller passes in `detail`. */
const SECRET_KEY = /pass(word)?|secret|token|key|hash/i;

@Injectable()
export class AuditService {
    private readonly logger = new Logger(AuditService.name);

    constructor(@InjectModel(AuditEvent.name) private readonly events: Model<AuditEventDocument>) {}

    /** Never throws: a failed audit write is logged loudly but must not undo the action it describes. */
    async record(entry: AuditEntry): Promise<void> {
        try {
            await this.events.create({
                at: new Date(),
                actorId: entry.actor ? new Types.ObjectId(entry.actor.id) : null,
                actorUsername: entry.actor?.username ?? null,
                action: entry.action,
                target: entry.target ?? null,
                ip: entry.ip,
                success: entry.success,
                detail: entry.detail ? redact(entry.detail) : null,
            });
        } catch (e) {
            this.logger.error(`audit write failed for ${entry.action}: ${errorMessage(e)}`);
        }
    }

    /**
     * Newest first. `before` is the opaque `nextBefore` of the previous page: `<ISO at>_<id>`. Rows that
     * share a millisecond are told apart by `_id`, the second sort key, so a page boundary that falls
     * inside such a group neither skips nor repeats a row. A bare ISO date still works (everything
     * strictly older than it).
     */
    async list(limit: number, before?: string): Promise<{ items: AuditEventView[]; nextBefore: string | null }> {
        const rows = await this.events
            .find(before ? cursorFilter(before) : {})
            .sort({ at: -1, _id: -1 })
            .limit(limit + 1)
            .lean()
            .exec();
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
            items: page.map((r) => ({
                id: String(r._id),
                at: r.at.toISOString(),
                actor: r.actorId ? { id: String(r.actorId), username: r.actorUsername ?? '' } : null,
                action: r.action,
                target: r.target,
                ip: r.ip,
                success: r.success,
                detail: r.detail,
            })),
            nextBefore: rows.length > limit ? `${last.at.toISOString()}_${String(last._id)}` : null,
        };
    }
}

function cursorFilter(cursor: string): Record<string, unknown> {
    const sep = cursor.lastIndexOf('_');
    const at = new Date(sep === -1 ? cursor : cursor.slice(0, sep));
    const id = sep === -1 ? null : cursor.slice(sep + 1);
    if (Number.isNaN(at.getTime()) || (id !== null && !Types.ObjectId.isValid(id))) {
        throw new BadRequestException('before is not a valid cursor');
    }
    if (id === null) return { at: { $lt: at } };
    return { $or: [{ at: { $lt: at } }, { at, _id: { $lt: new Types.ObjectId(id) } }] };
}

function redact(detail: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) {
        out[k] = SECRET_KEY.test(k)
            ? '[redacted]'
            : v && typeof v === 'object' && !Array.isArray(v)
              ? redact(v as Record<string, unknown>)
              : v;
    }
    return out;
}
