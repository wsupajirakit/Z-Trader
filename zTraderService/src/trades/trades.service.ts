import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { errorMessage } from '../common/utils/errors';
import { CtraderService } from '../ctrader/ctrader.service';
import { GoldInstrumentService } from '../gold/gold-instrument.service';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import type { CtDeal, CtDealList, CtExecutionEvent, CtOrder, CtPosition, CtReconcile } from './ctrader-payloads';
import { isBuy, isClosed, num } from './ctrader-payloads';
import { CloseReason, Trade, TradeDocument } from './schemas/trade.schema';

/** ProtoOAExecutionType ORDER_FILLED (3) and ORDER_PARTIAL_FILL (11), by name or number */
const FILL_EVENTS = new Set<unknown>(['ORDER_FILLED', 'ORDER_PARTIAL_FILL', 3, 11]);
/** ProtoOADealStatus FILLED (2) and PARTIALLY_FILLED (3) */
const FILLED = new Set<unknown>(['FILLED', 'PARTIALLY_FILLED', 2, 3]);

const RECONCILE_MS = 60_000;
const FIRST_RECONCILE_MS = 10_000;
const WEEK_MS = 7 * 86_400_000;
/** an empty ledger is filled from this far back once; later starts only look one week back */
const FIRST_BACKFILL_DAYS = 90;

export interface TradeListQuery {
    status?: 'open' | 'closed' | 'all';
    limit?: number;
    /** openedAt cursor (ms): rows opened strictly before it */
    before?: number;
}

/**
 * The trade ledger. cTrader pushes an execution event when an order fills and when a position
 * closes (take-profit, stop-loss or a market close); each event updates one row at once, so the
 * history needs no polling. Every minute one reconcile request refreshes stop/target levels and
 * closes rows whose position vanished while the service was not listening (their closing deals
 * are read back), and the first start imports the recent deal history.
 */
@Injectable()
export class TradesService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TradesService.name);
    private timer?: NodeJS.Timeout;
    private backfilled = false;

    constructor(
        @InjectModel(Trade.name) private readonly trades: Model<TradeDocument>,
        @InjectModel(Order.name) private readonly orders: Model<OrderDocument>,
        private readonly ctrader: CtraderService,
        private readonly instruments: GoldInstrumentService,
    ) {}

    onModuleInit() {
        // the first pass soon after start (cTrader authorises within seconds), then once a minute
        setTimeout(() => void this.reconcile(), FIRST_RECONCILE_MS).unref();
        this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
        this.timer.unref();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    // ---------------- events (real time) ----------------

    @OnEvent('ctrader.execution')
    async onExecution(e: CtExecutionEvent) {
        const deal = e?.deal;
        if (!deal || !FILL_EVENTS.has(e.executionType)) return;
        try {
            if (deal.closePositionDetail)
                await this.recordClose(deal, e.order ?? null, isClosed(e.position?.positionStatus));
            else await this.recordOpen(deal, e.position);
        } catch (err) {
            this.logger.error(`Trade ledger: could not record deal ${num(deal.dealId)}: ${errorMessage(err)}`);
        }
    }

    private profile(symbolId: number) {
        const p = this.instruments.profileBySymbolId(symbolId);
        return {
            symbol: p?.key ?? `#${symbolId}`,
            digits: p?.digits ?? 5,
            // cTrader volume is in hundredths of a unit
            lots: (volume: number) => volume / ((p?.unitsPerLot ?? 100_000) * 100),
        };
    }

    private async linkOrder(positionId: number) {
        const o = await this.orders.findOne({ positionId }).lean().exec();
        return o ? { orderUuid: o.uuid, mode: o.mode, strategy: o.strategy } : {};
    }

    /** an opening fill: the position now exists and runs */
    async recordOpen(deal: CtDeal, position?: CtPosition) {
        const positionId = num(deal.positionId);
        const symbolId = num(deal.symbolId);
        const prof = this.profile(symbolId);
        await this.trades.updateOne(
            { positionId },
            {
                $setOnInsert: {
                    positionId,
                    symbolId,
                    symbol: prof.symbol,
                    digits: prof.digits,
                    side: isBuy(deal.tradeSide) ? 'BUY' : 'SELL',
                    lots: prof.lots(num(deal.filledVolume ?? deal.volume)),
                    entry: num(position?.price ?? deal.executionPrice),
                    openedAt: new Date(num(deal.executionTimestamp) || Date.now()),
                    status: 'OPEN',
                    ...(await this.linkOrder(positionId)),
                },
            },
            { upsert: true },
        );
    }

    /**
     * a closing fill: books the broker's money figures once per closing deal; the row closes when
     * the position is fully closed
     */
    async recordClose(deal: CtDeal, order: CtOrder | null, fullyClosed: boolean) {
        const d = deal.closePositionDetail!;
        const scale = 10 ** num(d.moneyDigits ?? deal.moneyDigits ?? 2);
        const gross = num(d.grossProfit) / scale;
        const commission = num(d.commission) / scale;
        const swap = num(d.swap) / scale;
        const dealId = num(deal.dealId);
        const positionId = num(deal.positionId);
        const symbolId = num(deal.symbolId);
        const prof = this.profile(symbolId);
        const closedLots = prof.lots(num(d.closedVolume ?? deal.filledVolume));
        const closePrice = num(deal.executionPrice);
        const closedAt = new Date(num(deal.executionTimestamp) || Date.now());
        const reason = closeReason(order, closePrice);
        // the opening fill may predate the ledger: create the row from what the closing deal knows
        await this.trades.updateOne(
            { positionId },
            {
                $setOnInsert: {
                    positionId,
                    symbolId,
                    symbol: prof.symbol,
                    digits: prof.digits,
                    // the closing deal trades against the position
                    side: isBuy(deal.tradeSide) ? 'SELL' : 'BUY',
                    lots: closedLots,
                    entry: num(d.entryPrice),
                    openedAt: closedAt,
                    status: 'OPEN',
                    ...(await this.linkOrder(positionId)),
                },
            },
            { upsert: true },
        );
        const booked = await this.trades
            .findOneAndUpdate(
                { positionId, closeDealIds: { $ne: dealId } },
                {
                    $inc: {
                        closedLots,
                        grossUsd: gross,
                        commissionUsd: commission,
                        swapUsd: swap,
                        netUsd: gross + commission + swap,
                    },
                    $push: { closeDealIds: dealId },
                    $set: { closePrice, closedAt, ...(reason ? { closeReason: reason } : {}) },
                },
                { returnDocument: 'after' },
            )
            .lean()
            .exec();
        if (booked && (fullyClosed || booked.closedLots >= booked.lots - 1e-9)) {
            await this.trades.updateOne({ positionId }, { $set: { status: 'CLOSED' } });
        }
    }

    // ---------------- reconcile (one request a minute) ----------------

    async reconcile() {
        if (!this.ctrader.isAuthorized) return;
        try {
            if (!this.backfilled) await this.backfill();
            const res = (await this.ctrader.getPositions()) as CtReconcile | null;
            const live = new Map<number, CtPosition>((res?.position ?? []).map((p) => [num(p.positionId), p]));
            for (const [positionId, p] of live) {
                const symbolId = num(p.tradeData?.symbolId);
                const prof = this.profile(symbolId);
                await this.trades.updateOne(
                    { positionId },
                    {
                        $setOnInsert: {
                            positionId,
                            symbolId,
                            symbol: prof.symbol,
                            digits: prof.digits,
                            side: isBuy(p.tradeData?.tradeSide) ? 'BUY' : 'SELL',
                            lots: prof.lots(num(p.tradeData?.volume)),
                            entry: num(p.price),
                            openedAt: new Date(num(p.tradeData?.openTimestamp) || Date.now()),
                            status: 'OPEN',
                            ...(await this.linkOrder(positionId)),
                        },
                        $set: {
                            ...(p.stopLoss ? { stopLoss: num(p.stopLoss) } : {}),
                            ...(p.takeProfit ? { takeProfit: num(p.takeProfit) } : {}),
                        },
                    },
                    { upsert: true },
                );
            }
            const orphans = await this.trades
                .find({ status: 'OPEN', positionId: { $nin: [...live.keys()] } })
                .lean()
                .exec();
            if (orphans.length) {
                const from = Math.min(...orphans.map((o) => new Date(o.openedAt).getTime())) - 60_000;
                await this.importDeals(from, Date.now());
            }
        } catch (err) {
            this.logger.warn(`Trade ledger reconcile failed: ${errorMessage(err)}`);
        }
    }

    private async backfill() {
        const empty = (await this.trades.estimatedDocumentCount().exec()) === 0;
        const days = empty ? FIRST_BACKFILL_DAYS : 7;
        await this.importDeals(Date.now() - days * 86_400_000, Date.now());
        this.backfilled = true;
        this.logger.log(`Trade ledger: imported the last ${days} days of deals`);
    }

    /** replays the account's deals of a period (opening fills first) into the ledger */
    private async importDeals(from: number, to: number) {
        const deals: CtDeal[] = [];
        for (let t = from; t < to; t += WEEK_MS) {
            const res = (await this.ctrader.getDealList(t, Math.min(t + WEEK_MS, to))) as CtDealList | null;
            deals.push(...(res?.deal ?? []));
        }
        deals.sort((a, b) => num(a.executionTimestamp) - num(b.executionTimestamp));
        for (const deal of deals) {
            if (!FILLED.has(deal.dealStatus ?? 'FILLED')) continue;
            if (deal.closePositionDetail) await this.recordClose(deal, null, false);
            else await this.recordOpen(deal);
        }
    }

    // ---------------- reads ----------------

    async list(q: TradeListQuery) {
        const filter: Record<string, unknown> = {};
        if (q.status === 'open') filter.status = 'OPEN';
        if (q.status === 'closed') filter.status = 'CLOSED';
        if (q.before) filter.openedAt = { $lt: new Date(q.before) };
        const limit = Math.max(1, Math.min(500, q.limit ?? 200));
        const [rows, totals] = await Promise.all([
            this.trades
                .find(filter, { _id: 0, __v: 0, closeDealIds: 0 })
                .sort({ openedAt: -1 })
                .limit(limit)
                .lean()
                .exec(),
            this.trades
                .aggregate<{ _id: null; closed: number; wins: number; net: number; gross: number; open: number }>([
                    {
                        $group: {
                            _id: null,
                            closed: { $sum: { $cond: [{ $eq: ['$status', 'CLOSED'] }, 1, 0] } },
                            open: { $sum: { $cond: [{ $eq: ['$status', 'OPEN'] }, 1, 0] } },
                            wins: {
                                $sum: {
                                    $cond: [{ $and: [{ $eq: ['$status', 'CLOSED'] }, { $gt: ['$netUsd', 0] }] }, 1, 0],
                                },
                            },
                            net: { $sum: '$netUsd' },
                            gross: { $sum: '$grossUsd' },
                        },
                    },
                ])
                .exec(),
        ]);
        const t = totals[0];
        return {
            trades: rows,
            summary: {
                open: t?.open ?? 0,
                closed: t?.closed ?? 0,
                wins: t?.wins ?? 0,
                net_usd: round2(t?.net ?? 0),
                gross_usd: round2(t?.gross ?? 0),
            },
            next_before: rows.length === limit ? new Date(rows[rows.length - 1].openedAt).getTime() : null,
        };
    }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Why a position closed. A STOP_LOSS_TAKE_PROFIT closing order carries both levels (limitPrice =
 * take-profit, stopPrice = stop-loss); the fill is the one it sits nearer to. A market close is MANUAL.
 * Deals read back from history carry no order, so their reason stays unknown.
 */
export function closeReason(order: CtOrder | null, closePrice: number): CloseReason | undefined {
    if (!order?.closingOrder) return undefined;
    if (order.orderType === 'STOP_LOSS_TAKE_PROFIT' || order.orderType === 6) {
        const tp = order.limitPrice != null ? num(order.limitPrice) : null;
        const sl = order.stopPrice != null ? num(order.stopPrice) : null;
        if (tp == null) return 'SL';
        if (sl == null) return 'TP';
        return Math.abs(closePrice - tp) <= Math.abs(closePrice - sl) ? 'TP' : 'SL';
    }
    return 'MANUAL';
}
