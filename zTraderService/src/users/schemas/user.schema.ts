import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { ROLES, type Role } from '../../common/auth/roles';

@Schema({ collection: 'users', timestamps: true })
export class User {
    @Prop({ required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9._-]{3,32}$/ })
    username!: string;

    @Prop({ required: true, trim: true, maxlength: 80 })
    name!: string;

    @Prop({ required: true, enum: ROLES })
    role!: Role;

    /** scrypt hash — never selected unless asked for explicitly */
    @Prop({ required: true, select: false })
    passwordHash!: string;

    @Prop({ default: false })
    disabled!: boolean;

    /** set by create/reset so a password chosen by an admin is never the long-term one */
    @Prop({ default: true })
    mustChangePassword!: boolean;

    @Prop({ default: 0 })
    failedLogins!: number;

    @Prop({ type: Date, default: null })
    lockedUntil!: Date | null;

    @Prop({ type: Date, default: null })
    lastLoginAt!: Date | null;

    @Prop({ type: Date, default: null })
    passwordChangedAt!: Date | null;

    createdAt!: Date;
    updatedAt!: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
