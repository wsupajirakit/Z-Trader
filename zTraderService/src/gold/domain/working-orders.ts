/**
 * What is already working at the broker for one instrument, read from a cTrader reconcile:
 * pending entry orders (limit/stop that has not filled) and open positions. Used to refuse a new
 * order that repeats a setup already in place.
 *
 * Measured 3 Nov 2026 on DEMO: the scalp round re-sent the same GBPUSD BUY LIMIT @1.34176 every
 * five minutes (5 orders, none cancelled), and scalp + intraday both sent EURUSD @1.1197; they all
 * filled within the same second. The duplicate test below compares side and price only, so it holds
 * whether or not the broker echoes clientOrderId back in the reconcile.
 */
type Num = number | string | { toString(): string } | null | undefined;
const num = (v: Num) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));
const isBuy = (side: unknown) => side === 1 || side === 'BUY';

export interface WorkingEntry {
    kind: 'pending' | 'position';
    id: number;
    side: 'BUY' | 'SELL';
    price: number;
    clientOrderId: string;
}

export interface ReconcileLike {
    position?: Array<{ positionId?: Num; price?: Num; tradeData?: { symbolId?: Num; tradeSide?: unknown } }>;
    order?: Array<{
        orderId?: Num;
        closingOrder?: boolean;
        limitPrice?: Num;
        stopPrice?: Num;
        clientOrderId?: string;
        tradeData?: { symbolId?: Num; tradeSide?: unknown };
    }>;
}

export function workingEntries(rec: ReconcileLike | null | undefined, symbolId: number): WorkingEntry[] {
    const out: WorkingEntry[] = [];
    for (const o of rec?.order ?? []) {
        if (o.closingOrder || num(o.tradeData?.symbolId) !== symbolId) continue;
        out.push({
            kind: 'pending',
            id: num(o.orderId),
            side: isBuy(o.tradeData?.tradeSide) ? 'BUY' : 'SELL',
            price: num(o.limitPrice ?? o.stopPrice),
            clientOrderId: String(o.clientOrderId ?? ''),
        });
    }
    for (const p of rec?.position ?? []) {
        if (num(p.tradeData?.symbolId) !== symbolId) continue;
        out.push({
            kind: 'position',
            id: num(p.positionId),
            side: isBuy(p.tradeData?.tradeSide) ? 'BUY' : 'SELL',
            price: num(p.price),
            clientOrderId: '',
        });
    }
    return out;
}

/** a working order or position on the same side whose price is within `tolerance` of the new entry */
export function duplicateOf(
    entries: readonly WorkingEntry[],
    side: 'BUY' | 'SELL',
    entry: number,
    tolerance: number,
): WorkingEntry | undefined {
    return entries.find((e) => e.side === side && Math.abs(e.price - entry) <= tolerance);
}
