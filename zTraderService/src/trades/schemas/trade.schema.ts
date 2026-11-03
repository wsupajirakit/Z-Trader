import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TradeDocument = Trade & Document;

export type TradeStatus = 'OPEN' | 'CLOSED';
/** TP / SL = the position's own take-profit or stop-loss; MANUAL = a market close (dashboard, bot or broker app) */
export type CloseReason = 'TP' | 'SL' | 'MANUAL';

/**
 * One row per cTrader position, every instrument, kept forever: when it filled, how it closed and
 * the broker's own money figures (gross, commission, swap, net in the account currency).
 * Written from cTrader's execution events as they happen; a light reconcile fills any gap.
 */
@Schema({ timestamps: true, collection: 'trades' })
export class Trade {
    @Prop({ required: true, unique: true })
    positionId!: number;

    @Prop({ required: true })
    symbol!: string;

    @Prop({ required: true })
    symbolId!: number;

    @Prop({ required: true })
    side!: 'BUY' | 'SELL';

    @Prop({ required: true })
    lots!: number;

    @Prop({ required: true })
    digits!: number;

    @Prop({ required: true })
    entry!: number;

    @Prop() stopLoss?: number;
    @Prop() takeProfit?: number;

    @Prop({ required: true, index: true })
    openedAt!: Date;

    @Prop({ required: true, index: true })
    status!: TradeStatus;

    @Prop() closedAt?: Date;
    @Prop() closePrice?: number;
    @Prop() closeReason?: CloseReason;
    /** lots closed so far (partial closes add up) */
    @Prop({ default: 0 }) closedLots!: number;
    /** closing deals already booked: a repeated event or a history replay never counts twice */
    @Prop({ type: [Number], default: [] }) closeDealIds!: number[];

    @Prop({ default: 0 }) grossUsd!: number;
    @Prop({ default: 0 }) commissionUsd!: number;
    @Prop({ default: 0 }) swapUsd!: number;
    @Prop({ default: 0 }) netUsd!: number;

    /** the bot's order behind this position, when there is one */
    @Prop() orderUuid?: string;
    @Prop() mode?: string;
    @Prop() strategy?: string;
}

export const TradeSchema = SchemaFactory.createForClass(Trade);
TradeSchema.index({ status: 1, openedAt: -1 });
