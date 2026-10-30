import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import type { RiskProfileValues } from '../risk-profile-values';

/** a risk profile saved from the dashboard; built-in profiles live in code, not here */
@Schema({ collection: 'risk_profiles', timestamps: true })
export class RiskProfile {
    @Prop({ required: true, unique: true, trim: true, minlength: 1, maxlength: 40 })
    name!: string;

    @Prop({ trim: true, maxlength: 200, default: '' })
    description!: string;

    @Prop({ type: MongooseSchema.Types.Mixed, required: true })
    values!: RiskProfileValues;

    @Prop({ required: true })
    createdBy!: string;

    @Prop({ default: '' })
    updatedBy!: string;

    createdAt!: Date;
    updatedAt!: Date;
}

export type RiskProfileDocument = HydratedDocument<RiskProfile>;
export const RiskProfileSchema = SchemaFactory.createForClass(RiskProfile);
