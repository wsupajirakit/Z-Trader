import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { hashPassword, passwordProblem } from '../auth/password';
import type { Role } from '../common/auth/roles';
import { User, UserDocument } from './schemas/user.schema';

export interface UserView {
    id: string;
    username: string;
    name: string;
    role: Role;
    disabled: boolean;
    mustChangePassword: boolean;
    lastLoginAt: string | null;
    createdAt: string;
}

export function toUserView(u: UserDocument): UserView {
    return {
        id: String(u._id),
        username: u.username,
        name: u.name,
        role: u.role,
        disabled: u.disabled,
        mustChangePassword: u.mustChangePassword,
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        createdAt: u.createdAt.toISOString(),
    };
}

interface CreateUserInput {
    username: string;
    name: string;
    role: Role;
    password: string;
    mustChangePassword?: boolean;
}

@Injectable()
export class UsersService {
    constructor(@InjectModel(User.name) private readonly users: Model<UserDocument>) {}

    count(): Promise<number> {
        return this.users.estimatedDocumentCount().exec();
    }

    list(): Promise<UserDocument[]> {
        return this.users.find().sort({ username: 1 }).exec();
    }

    findById(id: string): Promise<UserDocument | null> {
        return this.users.findById(id).exec();
    }

    findByUsernameWithHash(username: string): Promise<UserDocument | null> {
        return this.users.findOne({ username: username.trim().toLowerCase() }).select('+passwordHash').exec();
    }

    findByIdWithHash(id: string): Promise<UserDocument | null> {
        return this.users.findById(id).select('+passwordHash').exec();
    }

    async create(input: CreateUserInput): Promise<UserDocument> {
        const username = input.username.trim().toLowerCase();
        const problem = passwordProblem(input.password, username);
        if (problem) throw new BadRequestException(problem);
        try {
            return await this.users.create({
                username,
                name: input.name,
                role: input.role,
                passwordHash: await hashPassword(input.password),
                mustChangePassword: input.mustChangePassword ?? true,
            });
        } catch (e) {
            if ((e as { code?: number }).code === 11000) throw new ConflictException('ชื่อผู้ใช้นี้มีอยู่แล้ว');
            throw e;
        }
    }

    /**
     * Applies an admin edit. Refuses anything that would leave the system without an active admin,
     * and refuses an admin demoting or disabling themselves (ask another admin).
     *
     * The last-admin rule has to hold when two admins demote each other at the same moment, and MongoDB
     * may be a standalone server here (no transactions). So the change that removes an admin is written
     * first, with a filter that only matches while the target is still an active admin, and the active
     * admins are counted afterwards. If that count is 0 the change is put back, again only if the
     * document still holds what this request wrote, and the request gets a 400. Every demotion counts
     * after its own write, so the last of two racing demotions always sees the other one and backs out
     * (at worst both back out). Neither can leave 0 admins.
     */
    async update(
        actorId: string,
        id: string,
        patch: { name?: string; role?: Role; disabled?: boolean },
    ): Promise<{ before: UserDocument; after: UserDocument }> {
        const user = await this.mustFind(id);
        const set: Partial<Pick<User, 'name' | 'role' | 'disabled'>> = {};
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.role !== undefined) set.role = patch.role;
        if (patch.disabled !== undefined) set.disabled = patch.disabled;

        const losesAdmin = (u: { role: Role; disabled: boolean }) =>
            u.role === 'admin' &&
            !u.disabled &&
            ((set.role !== undefined && set.role !== 'admin') || set.disabled === true);

        if (!losesAdmin(user)) {
            const after = await this.users
                .findOneAndUpdate({ _id: user._id }, { $set: set }, { returnDocument: 'after', runValidators: true })
                .exec();
            if (!after) throw new NotFoundException('ไม่พบผู้ใช้');
            return { before: user, after };
        }
        if (String(user._id) === actorId) {
            throw new BadRequestException('ลดสิทธิ์หรือปิดบัญชีของตัวเองไม่ได้ — ให้ admin คนอื่นทำ');
        }
        const lastAdmin = () => new BadRequestException('ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คนเสมอ');
        // cheap early answer for the common, non-racing case
        if ((await this.activeAdminCount()) <= 1) throw lastAdmin();

        const before = await this.users
            .findOneAndUpdate(
                { _id: user._id, role: 'admin', disabled: false },
                { $set: set },
                { returnDocument: 'before', runValidators: true },
            )
            .exec();
        if (!before) {
            // another admin changed this user between our read and our write; let the caller retry on fresh data
            throw new ConflictException('ผู้ใช้นี้ถูกแก้ไขพร้อมกันจากที่อื่น — โหลดใหม่แล้วลองอีกครั้ง');
        }
        if ((await this.activeAdminCount()) === 0) {
            const wrote = { role: set.role ?? before.role, disabled: set.disabled ?? before.disabled };
            const restore: Record<string, unknown> = { role: before.role, disabled: before.disabled };
            if (set.name !== undefined) restore.name = before.name;
            await this.users.updateOne({ _id: before._id, ...wrote }, { $set: restore }).exec();
            throw lastAdmin();
        }
        const after = await this.mustFind(id);
        return { before, after };
    }

    /**
     * Counts one wrong password in a single atomic update, so parallel attempts cannot all read the same
     * count and each write back count + 1. While the account is locked, failures are not counted. When
     * the count reaches `max`, the account is locked until `lockUntil` and the counter starts again.
     * Returns the account's lockedUntil after the update.
     */
    async recordFailedLogin(id: string, max: number, now: Date, lockUntil: Date): Promise<Date | null> {
        const count = { $ifNull: ['$failedLogins', 0] };
        const isLocked = { $gt: [{ $ifNull: ['$lockedUntil', new Date(0)] }, now] };
        const reached = { $gte: ['$failedLogins', max] };
        const doc = await this.users
            .findOneAndUpdate(
                { _id: id },
                [
                    { $set: { failedLogins: { $cond: [isLocked, count, { $add: [count, 1] }] } } },
                    {
                        $set: {
                            lockedUntil: { $cond: [reached, lockUntil, '$lockedUntil'] },
                            failedLogins: { $cond: [reached, 0, '$failedLogins'] },
                        },
                    },
                ],
                { returnDocument: 'after', updatePipeline: true },
            )
            .lean()
            .exec();
        return doc?.lockedUntil ?? null;
    }

    /**
     * Records a successful login, but only while the account is not locked: a parallel wrong password
     * may have locked it after this request checked. Returns null in that case, and the login must fail.
     */
    recordLogin(id: string, now: Date, newPasswordHash?: string): Promise<UserDocument | null> {
        const set: Record<string, unknown> = { failedLogins: 0, lockedUntil: null, lastLoginAt: now };
        if (newPasswordHash) set.passwordHash = newPasswordHash;
        return this.users
            .findOneAndUpdate(
                { _id: id, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
                { $set: set },
                { returnDocument: 'after' },
            )
            .exec();
    }

    async setPassword(id: string, password: string, mustChangePassword: boolean): Promise<UserDocument> {
        const user = await this.mustFind(id);
        const problem = passwordProblem(password, user.username);
        if (problem) throw new BadRequestException(problem);
        user.passwordHash = await hashPassword(password);
        user.mustChangePassword = mustChangePassword;
        user.passwordChangedAt = new Date();
        user.failedLogins = 0;
        user.lockedUntil = null;
        return user.save();
    }

    private activeAdminCount(): Promise<number> {
        return this.users.countDocuments({ role: 'admin', disabled: false }).exec();
    }

    private async mustFind(id: string): Promise<UserDocument> {
        const user = await this.users.findById(id).select('+passwordHash').exec();
        if (!user) throw new NotFoundException('ไม่พบผู้ใช้');
        return user;
    }
}
