import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * One row per signed-in browser. `_id` is the SHA-256 of the cookie token, so a copy of this collection
 * cannot be replayed as cookies. `publicId` is what the UI sees and revokes.
 */
@Schema({ collection: 'sessions', versionKey: false })
export class Session {
    @Prop({ type: String, required: true })
    _id!: string;

    @Prop({ required: true, unique: true })
    publicId!: string;

    @Prop({ type: Types.ObjectId, required: true, index: true })
    userId!: Types.ObjectId;

    @Prop({ required: true })
    csrfToken!: string;

    @Prop({ required: true })
    createdAt!: Date;

    @Prop({ required: true })
    lastSeenAt!: Date;

    /** hard cap from login time — never extended */
    @Prop({ required: true })
    absoluteExpiresAt!: Date;

    /** min(absolute cap, lastSeen + idle window); MongoDB's TTL monitor deletes the row after this */
    @Prop({ required: true, index: { expireAfterSeconds: 0 } })
    expiresAt!: Date;

    @Prop({ default: '' })
    ip!: string;

    @Prop({ default: '' })
    userAgent!: string;
}

export type SessionDocument = HydratedDocument<Session>;
export const SessionSchema = SchemaFactory.createForClass(Session);
