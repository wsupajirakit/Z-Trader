/**
 * Trade ledger (src/trades) against a throwaway MongoDB, fed with real cTrader execution events
 * copied from order.log (an XAUUSD sell closed by its take-profit, an EURUSD limit buy that filled).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const require = createRequire(import.meta.url);
const DIST = resolve(import.meta.dirname, '../../dist');
const mongoose = require('mongoose');
const { TradesService, closeReason } = require(`${DIST}/trades/trades.service`);
const { TradeSchema } = require(`${DIST}/trades/schemas/trade.schema`);
const { OrderSchema } = require(`${DIST}/orders/schemas/order.schema`);

const XAU_OPEN = {
    executionType: 'ORDER_FILLED',
    deal: {
        dealId: '955237120',
        positionId: '691427255',
        symbolId: '41',
        tradeSide: 'SELL',
        volume: '200',
        filledVolume: '200',
        executionPrice: 3989.68,
        executionTimestamp: '1793352539437',
        moneyDigits: 2,
        dealStatus: 'FILLED',
    },
    order: { orderType: 'MARKET', closingOrder: false },
    position: { positionId: '691427255', price: 3989.68, positionStatus: 'POSITION_STATUS_OPEN' },
};
const XAU_CLOSE_TP = {
    executionType: 'ORDER_FILLED',
    deal: {
        dealId: '955247498',
        positionId: '691427255',
        symbolId: '41',
        tradeSide: 'BUY',
        volume: '200',
        filledVolume: '200',
        executionPrice: 3984.64,
        executionTimestamp: '1793355112573',
        moneyDigits: 2,
        dealStatus: 'FILLED',
        closePositionDetail: {
            entryPrice: 3989.68,
            grossProfit: '1008',
            swap: '0',
            commission: '-48',
            closedVolume: '200',
            moneyDigits: 2,
        },
    },
    order: { orderType: 'STOP_LOSS_TAKE_PROFIT', closingOrder: true, limitPrice: 3984.68, stopPrice: 3993.68 },
    position: { positionId: '691427255', price: 0, positionStatus: 'POSITION_STATUS_CLOSED' },
};
const EUR_OPEN = {
    executionType: 'ORDER_FILLED',
    deal: {
        dealId: '956242466',
        positionId: '692085525',
        symbolId: '1',
        tradeSide: 'BUY',
        volume: '14300000',
        filledVolume: '14300000',
        executionPrice: 1.11969,
        executionTimestamp: '1793691967354',
        moneyDigits: 2,
        dealStatus: 'FILLED',
    },
    order: { orderType: 'LIMIT', closingOrder: false, limitPrice: 1.1197 },
    position: { positionId: '692085525', price: 1.11969, positionStatus: 'POSITION_STATUS_OPEN' },
};

const PROFILES: Record<number, { key: string; digits: number; unitsPerLot: number }> = {
    41: { key: 'XAUUSD', digits: 2, unitsPerLot: 100 },
    1: { key: 'EURUSD', digits: 5, unitsPerLot: 100_000 },
};

describe('trade ledger', () => {
    let mongo: MongoMemoryServer | null = null;
    let conn: any;
    let ledger: any;
    let trades: any;
    let ctrader: {
        isAuthorized: boolean;
        positions: unknown[];
        deals: unknown[];
        getPositions: () => Promise<unknown>;
        getDealList: () => Promise<unknown>;
    };

    before(async () => {
        mongo = process.env.TEST_MONGO_URI ? null : await MongoMemoryServer.create();
        const uri = process.env.TEST_MONGO_URI ?? mongo!.getUri();
        conn = await mongoose.createConnection(uri, { dbName: `ledger_${Date.now()}` }).asPromise();
        trades = conn.model('Trade', TradeSchema);
        await trades.init();
    });
    after(async () => {
        await conn.dropDatabase();
        await conn.close();
        await mongo?.stop();
    });
    beforeEach(async () => {
        await trades.deleteMany({});
        ctrader = {
            isAuthorized: true,
            positions: [],
            deals: [],
            getPositions() {
                return { position: this.positions };
            },
            getDealList() {
                return { deal: this.deals };
            },
        };
        ledger = new TradesService(trades, conn.model('Order', OrderSchema), ctrader, {
            profileBySymbolId: (id: number) => PROFILES[id] ?? null,
        });
    });

    it('books a position from its fill to its take-profit with the broker money', async () => {
        await ledger.onExecution(XAU_OPEN);
        let row = await trades.findOne({ positionId: 691427255 }).lean();
        assert.equal(row.status, 'OPEN');
        assert.equal(row.symbol, 'XAUUSD');
        assert.equal(row.side, 'SELL');
        assert.equal(row.lots, 0.02);
        await ledger.onExecution(XAU_CLOSE_TP);
        row = await trades.findOne({ positionId: 691427255 }).lean();
        assert.equal(row.status, 'CLOSED');
        assert.equal(row.closeReason, 'TP');
        assert.equal(row.closePrice, 3984.64);
        assert.equal(row.grossUsd, 10.08);
        assert.equal(row.commissionUsd, -0.48);
        assert.ok(Math.abs(row.netUsd - 9.6) < 1e-9);
    });

    it('never counts a closing deal twice (repeated event, history replay)', async () => {
        await ledger.onExecution(XAU_OPEN);
        await ledger.onExecution(XAU_CLOSE_TP);
        await ledger.onExecution(XAU_CLOSE_TP);
        ctrader.deals = [XAU_OPEN.deal, XAU_CLOSE_TP.deal];
        await ledger.reconcile(); // first reconcile also replays recent history
        const row = await trades.findOne({ positionId: 691427255 }).lean();
        assert.ok(Math.abs(row.netUsd - 9.6) < 1e-9);
        assert.equal(row.closedLots, 0.02);
    });

    it('an FX fill is a running position with the right lot size', async () => {
        await ledger.onExecution(EUR_OPEN);
        const row = await trades.findOne({ positionId: 692085525 }).lean();
        assert.equal(row.status, 'OPEN');
        assert.equal(row.lots, 1.43);
        assert.equal(row.entry, 1.11969);
    });

    it('closes a position that vanished while nobody listened, from the deal history', async () => {
        await ledger.onExecution(XAU_OPEN);
        ctrader.positions = []; // gone at the broker
        ctrader.deals = [XAU_CLOSE_TP.deal];
        await ledger.reconcile();
        const row = await trades.findOne({ positionId: 691427255 }).lean();
        assert.equal(row.status, 'CLOSED');
        assert.ok(Math.abs(row.netUsd - 9.6) < 1e-9);
    });

    it('lists every instrument with a running total', async () => {
        await ledger.onExecution(XAU_OPEN);
        await ledger.onExecution(XAU_CLOSE_TP);
        await ledger.onExecution(EUR_OPEN);
        const out = await ledger.list({ status: 'all' });
        assert.deepEqual(
            out.trades.map((t: { symbol: string }) => t.symbol),
            ['EURUSD', 'XAUUSD'],
        );
        assert.equal(out.trades[0].closeDealIds, undefined);
        assert.deepEqual(out.summary, { open: 1, closed: 1, wins: 1, net_usd: 9.6, gross_usd: 10.08 });
    });

    it('names the close: nearer level of an SL/TP order, MANUAL for a market close', () => {
        const tpsl = { closingOrder: true, orderType: 'STOP_LOSS_TAKE_PROFIT', limitPrice: 100, stopPrice: 90 };
        assert.equal(closeReason(tpsl, 99.9), 'TP');
        assert.equal(closeReason(tpsl, 90.2), 'SL');
        assert.equal(closeReason({ closingOrder: true, orderType: 'MARKET' }, 95), 'MANUAL');
        assert.equal(closeReason(null, 95), undefined);
    });
});
