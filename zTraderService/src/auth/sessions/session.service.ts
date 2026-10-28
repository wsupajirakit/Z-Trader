import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { Session, SessionDocument } from './session.schema';

export const SESSION_ABSOLUTE_MS = 12 * 3_600_000;
export const SESSION_IDLE_MS = 2 * 3_600_000;
/** lastSeen is written at most this often, so dashboard polling does not turn every GET into a DB write */
const TOUCH_EVERY_MS = 60_000;

export interface SessionView {
    id: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    ip: string;
    userAgent: string;
    current: boolean;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class SessionService {
    /** injectable clock — tests move it forward instead of sleeping */
    now: () => number = Date.now;

    constructor(@InjectModel(Session.name) private readonly sessions: Model<SessionDocument>) {}

    async create(userId: string, ip: string, userAgent: string): Promise<{ token: string; session: SessionDocument }> {
        const token = randomBytes(32).toString('base64url');
        const now = this.now();
        const absolute = now + SESSION_ABSOLUTE_MS;
        const session = await this.sessions.create({
            _id: tokenHash(token),
            publicId: randomBytes(12).toString('base64url'),
            userId: new Types.ObjectId(userId),
            csrfToken: randomBytes(32).toString('base64url'),
            createdAt: new Date(now),
            lastSeenAt: new Date(now),
            absoluteExpiresAt: new Date(absolute),
            expiresAt: new Date(Math.min(absolute, now + SESSION_IDLE_MS)),
            ip,
            userAgent,
        });
        return { token, session };
    }

    /** the live session for a cookie token, sliding its idle window; null when unknown or expired */
    async resolve(token: string): Promise<SessionDocument | null> {
        // the cookie reader already filters, this keeps the service safe for any other caller
        if (typeof token !== 'string' || !token || token.length > 100) return null;
        const session = await this.sessions.findById(tokenHash(token)).exec();
        if (!session) return null;
        const now = this.now();
        // the TTL monitor runs about once a minute, so expiry is enforced here and not left to it
        if (session.expiresAt.getTime() <= now) {
            await session.deleteOne();
            return null;
        }
        if (now - session.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
            session.lastSeenAt = new Date(now);
            session.expiresAt = new Date(Math.min(session.absoluteExpiresAt.getTime(), now + SESSION_IDLE_MS));
            await session.save();
        }
        return session;
    }

    async listForUser(userId: string, currentPublicId: string): Promise<SessionView[]> {
        const rows = await this.sessions
            .find({ userId: new Types.ObjectId(userId), expiresAt: { $gt: new Date(this.now()) } })
            .sort({ lastSeenAt: -1 })
            .lean()
            .exec();
        return rows.map((s) => ({
            id: s.publicId,
            createdAt: s.createdAt.toISOString(),
            lastSeenAt: s.lastSeenAt.toISOString(),
            expiresAt: s.expiresAt.toISOString(),
            ip: s.ip,
            userAgent: s.userAgent,
            current: s.publicId === currentPublicId,
        }));
    }

    async revokeByToken(token: string): Promise<void> {
        if (typeof token !== 'string' || !token) return;
        await this.sessions.deleteOne({ _id: tokenHash(token) }).exec();
    }

    /** revoke one of the user's own sessions; false when it is not theirs or already gone */
    async revokeOwn(userId: string, publicId: string): Promise<boolean> {
        const r = await this.sessions.deleteOne({ userId: new Types.ObjectId(userId), publicId }).exec();
        return r.deletedCount === 1;
    }

    async revokeAllForUser(userId: string, exceptPublicId?: string): Promise<number> {
        const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
        if (exceptPublicId) filter.publicId = { $ne: exceptPublicId };
        const r = await this.sessions.deleteMany(filter).exec();
        return r.deletedCount;
    }
}
