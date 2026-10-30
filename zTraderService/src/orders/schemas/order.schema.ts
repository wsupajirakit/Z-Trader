import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ timestamps: true })
export class Order {
    @Prop({ required: true, unique: true })
    uuid!: string;

    @Prop()
    positionId?: number;

    @Prop()
    orderId?: number;

    @Prop({ required: true })
    symbol!: string;

    @Prop({ required: true })
    volume!: number;

    @Prop({ required: true })
    orderType!: string;

    @Prop({ required: true })
    side!: string;

    @Prop()
    price?: number;

    @Prop({ default: 'PENDING' })
    status!: string;

    @Prop()
    message?: string;

    @Prop({ type: Object })
    rawResponse?: any;

    @Prop()
    strategy?: string;

    @Prop()
    takeProfit?: number;

    @Prop()
    stopLoss?: number;

    @Prop()
    entryPrice?: number;

    @Prop()
    closePrice?: number;

    @Prop()
    positionEvent?: string;

    @Prop()
    mode?: string;

    // ---- gold bot: why we entered + where the TA context lives ----
    @Prop() engine?: string; // ta | ai
    @Prop() reason?: string; // one-line entry reason
    @Prop() playbookRef?: string; // e.g. "intraday #2"
    @Prop() invalidation?: string; // condition that kills the setup
    @Prop() tp2?: number;
    @Prop() rrTp1?: number;
    @Prop() confidence?: number;
    @Prop() archiveFile?: string; // archive/<mode>/<ts>_<mode>.json of the round
    @Prop() analysisSummary?: string; // TA summary at entry time
    // ---- configuration the order was placed under (see src/gold/records/round-context.ts) ----
    @Prop({ index: true }) configHash?: string; // groups orders placed under identical settings
    @Prop() riskProfile?: string; // risk profile name at entry ("custom" when none was applied)
    @Prop({ type: Object }) context?: Record<string, unknown>; // full RoundTrace: config, guards, sizing, AI answer
}

export const OrderSchema = SchemaFactory.createForClass(Order);
