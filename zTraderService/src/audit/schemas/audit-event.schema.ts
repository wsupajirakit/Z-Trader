import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const AUDIT_RETENTION_DAYS = 365;

@Schema({ collection: 'audit_events', versionKey: false })
export class AuditEvent {
    @Prop({ required: true, index: { expireAfterSeconds: AUDIT_RETENTION_DAYS * 86_400 } })
    at!: Date;

    @Prop({ type: Types.ObjectId, default: null })
    actorId!: Types.ObjectId | null;

    @Prop({ type: String, default: null })
    actorUsername!: string | null;

    @Prop({ required: true, index: true })
    action!: string;

    @Prop({ type: String, default: null })
    target!: string | null;

    @Prop({ default: '' })
    ip!: string;

    @Prop({ required: true })
    success!: boolean;

    @Prop({ type: Object, default: null })
    detail!: Record<string, unknown> | null;
}

export type AuditEventDocument = HydratedDocument<AuditEvent>;
export const AuditEventSchema = SchemaFactory.createForClass(AuditEvent);
