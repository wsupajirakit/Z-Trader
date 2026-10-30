import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CtraderService } from '../../ctrader/ctrader.service';
import { SingleFlightCache } from '../../common/utils/single-flight-cache';
import { errorMessage } from '../../common/utils/errors';

const DAY_MS = 24 * 3_600_000;
/** fresh enough for a P&L / cooldown guard that runs once per analysis round */
const TTL_MS = 20_000;
/** if cTrader cannot be reached, a deal list this young is still trusted */
const STALE_MS = 10 * 60_000;

export interface ClosedDeal {
    symbolId: number;
    /** execution time, ms since epoch */
    closedAt: number;
    /** gross profit + commission + swap, in account currency */
    netUsd: number;
}

type Num = number | { toString(): string } | null | undefined;
const num = (v: Num) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));

/**
 * One shared, cached read of the account's closing deals of the last 24 h. The daily-stop guard and
 * the loss-cooldown guard both need it on every analysis round of every instrument; reading it once
 * per few seconds (instead of once per guard per round) is what keeps the service under cTrader's
 * rate limit. Both guards derive their numbers from the same list.
 */
@Injectable()
export class DealCacheService {
    private readonly logger = new Logger(DealCacheService.name);
    private readonly cache = new SingleFlightCache<ClosedDeal[]>(() => this.fetch(), TTL_MS, STALE_MS);

    constructor(private readonly ctrader: CtraderService) {}

    /**
     * Closing deals since `sinceMs` (at most 24 h back). `stale` = cTrader could not be read and this
     * is the last good copy (at most 10 min old). Throws when there is no usable copy at all.
     */
    async closedSince(sinceMs: number): Promise<{ deals: ClosedDeal[]; stale: boolean; ageMs: number }> {
        const { data, stale, ageMs } = await this.cache.get();
        if (stale) this.logger.warn(`deal list unavailable — using a copy from ${Math.round(ageMs / 1000)} s ago`);
        return { deals: data.filter((d) => d.closedAt >= sinceMs), stale, ageMs };
    }

    /** drop the cached list so the next read goes to cTrader */
    invalidate(): void {
        this.cache.invalidate();
    }

    /** an order filled or a position closed: P&L and the last loss may have changed right now */
    @OnEvent('ctrader.execution')
    onExecution(): void {
        this.invalidate();
    }

    /** ProtoOADealListReq is slow now and then; one longer second try before giving up (rate limits are retried below us) */
    private async fetch(): Promise<ClosedDeal[]> {
        const timeouts = [20_000, 30_000];
        for (let attempt = 0; ; attempt++) {
            const now = Date.now();
            try {
                const res = await this.ctrader.getDealList(now - DAY_MS, now, timeouts[attempt]);
                return toClosedDeals((res?.deal ?? []) as any[]);
            } catch (e) {
                const last = attempt === timeouts.length - 1;
                this.logger.warn(`deal list attempt ${attempt + 1}/${timeouts.length} failed: ${errorMessage(e)}`);
                if (last) throw e;
            }
        }
    }
}

/** closing deals only (opening deals carry no closePositionDetail), money scaled by moneyDigits */
function toClosedDeals(raw: any[]): ClosedDeal[] {
    const out: ClosedDeal[] = [];
    for (const deal of raw) {
        const d = deal.closePositionDetail;
        if (!d) continue;
        const divisor = Math.pow(10, num(deal.moneyDigits) || 2);
        out.push({
            symbolId: num(deal.symbolId),
            closedAt: num(deal.executionTimestamp),
            netUsd: (num(d.grossProfit) + num(d.commission) + num(d.swap)) / divisor,
        });
    }
    return out;
}
