import { Injectable, ConflictException, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { errorMessage } from '../common/utils/errors';
import { Order, OrderDocument } from './schemas/order.schema';
import { demoContext } from '../common/demo/demo-context';

@Injectable()
export class OrdersService implements OnApplicationBootstrap {
    private readonly logger = new Logger(OrdersService.name);

    constructor(@InjectModel(Order.name) private orderModel: Model<OrderDocument>) {}

    /**
     * Idempotency of POST /orders rests on the unique index on `uuid`. Mongoose's autoIndex builds it
     * in the background and swallows a failure (typically duplicate uuids in legacy data), which would
     * silently turn the duplicate check off. So build it explicitly at boot and say so loudly if it
     * is not there. createIndexes only adds missing indexes; it never drops one.
     */
    async onApplicationBootstrap() {
        try {
            await this.orderModel.createIndexes();
            const indexes = await this.orderModel.collection.indexes();
            const ok = indexes.some((i) => i.unique === true && Object.keys(i.key ?? {}).join(',') === 'uuid');
            if (!ok) this.logger.error('orders.uuid has no unique index — duplicate orders are NOT prevented');
        } catch (e) {
            this.logger.error(
                `could not create the unique index on orders.uuid (${errorMessage(e)}) — duplicate orders are ` +
                    'NOT prevented until duplicate uuids are removed from the orders collection',
            );
        }
    }

    /** uuid is a unique index, so the insert itself is the duplicate check (no find-then-insert race) */
    async createOrder(orderData: Partial<Order>): Promise<OrderDocument> {
        demoContext.assertNotDemo('Recording an order');
        try {
            return await this.orderModel.create(orderData);
        } catch (e) {
            if ((e as { code?: number }).code === 11000) throw new ConflictException('Duplicate UUID');
            throw e;
        }
    }

    async updateOrderStatus(uuid: string, status: string, details?: any) {
        demoContext.assertNotDemo('Changing an order');
        return this.orderModel.findOneAndUpdate({ uuid }, { status, ...details }, { returnDocument: 'after' }).exec();
    }

    async findByUuid(uuid: string): Promise<OrderDocument | null> {
        return this.orderModel.findOne({ uuid }).exec();
    }

    async findByPositionIds(positionIds: number[]): Promise<OrderDocument[]> {
        if (!positionIds.length) return [];
        return this.orderModel.find({ positionId: { $in: positionIds } }).exec();
    }

    /** attach extra metadata (e.g. archive file path) to an order after the fact */
    async attachMeta(uuid: string, meta: Partial<Order>) {
        demoContext.assertNotDemo('Changing an order');
        return this.orderModel.findOneAndUpdate({ uuid }, { $set: meta }).exec();
    }

    async findAll(page: number = 1, limit: number = 20, mode?: string) {
        // a negative or fractional skip/limit is a Mongo error, i.e. a 500
        page = Math.max(1, Math.trunc(page) || 1);
        limit = Math.min(100, Math.max(1, Math.trunc(limit) || 20));
        const skip = (page - 1) * limit;
        const query = mode ? { mode: mode.toUpperCase() } : {};
        return this.orderModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).exec();
    }

    async findToday(mode?: string) {
        const now = new Date();
        const utc7Offset = 7 * 60 * 60 * 1000;
        const localNow = new Date(now.getTime() + utc7Offset);
        const fromTimestamp =
            Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - utc7Offset;

        const query: any = {
            createdAt: { $gte: new Date(fromTimestamp) },
        };
        if (mode) query.mode = mode.toUpperCase();

        return this.orderModel.find(query).sort({ createdAt: -1 }).exec();
    }
}
