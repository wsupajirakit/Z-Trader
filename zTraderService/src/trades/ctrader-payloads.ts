/**
 * The parts of cTrader Open API messages the trade ledger and the positions view read. Decoded
 * protobuf gives 64-bit numbers as strings or Long objects and enums as names or numbers, so every
 * field is read through num() / the helpers below.
 */
export type Num = number | string | { toString(): string } | null | undefined;

export const num = (v: Num) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));
/** ProtoOATradeSide BUY = 1 */
export const isBuy = (side: unknown) => side === 1 || side === 'BUY';
/** ProtoOAPositionStatus POSITION_STATUS_CLOSED = 2 */
export const isClosed = (status: unknown) => status === 2 || status === 'POSITION_STATUS_CLOSED';

export interface CtTradeData {
    symbolId: Num;
    volume: Num;
    tradeSide: unknown;
    openTimestamp?: Num;
}

export interface CtPosition {
    positionId: Num;
    price?: Num;
    stopLoss?: Num;
    takeProfit?: Num;
    positionStatus?: unknown;
    tradeData?: CtTradeData;
}

export interface CtOrder {
    orderId?: Num;
    orderType?: unknown;
    closingOrder?: boolean;
    limitPrice?: Num;
    stopPrice?: Num;
    stopLoss?: Num;
    takeProfit?: Num;
    tradeData?: CtTradeData;
}

export interface CtClosePositionDetail {
    entryPrice: Num;
    grossProfit: Num;
    swap: Num;
    commission: Num;
    moneyDigits?: Num;
    closedVolume?: Num;
}

export interface CtDeal {
    dealId: Num;
    positionId: Num;
    symbolId: Num;
    tradeSide: unknown;
    volume?: Num;
    filledVolume?: Num;
    executionPrice: Num;
    executionTimestamp: Num;
    moneyDigits?: Num;
    dealStatus?: unknown;
    closePositionDetail?: CtClosePositionDetail;
}

export interface CtExecutionEvent {
    executionType?: unknown;
    deal?: CtDeal;
    order?: CtOrder;
    position?: CtPosition;
}

export interface CtReconcile {
    position?: CtPosition[];
    order?: CtOrder[];
}

export interface CtDealList {
    deal?: CtDeal[];
}
