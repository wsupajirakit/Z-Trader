import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CtraderService } from '../../ctrader/ctrader.service';
import { OrdersService } from '../../orders/orders.service';
import { enrich, Bar } from '../domain/indicators';
import { CTRADER_PERIOD, INTERVAL_MS } from '../domain/gold-modes';
import { InstrumentProfile } from '../domain/instruments';
import { GoldInstrumentService } from '../gold-instrument.service';
import { errorMessage } from '../../common/utils/errors';
import { DomainError } from '../domain/domain-error';

const WEEK_MS = 7 * 86_400_000; // cTrader deal-list max range per request
const PRICE_DIVISOR = 100_000;

export interface TradeRow {
    closed_utc: string;
    position_id: number;
    side: 'BUY' | 'SELL'; // position side
    lots: number;
    entry: number;
    close: number;
    gross_usd: number;
    net_usd: number; // gross + commission + swap
    strategy: string; // from Mongo order (GOLD_AI / SONIC / SCALPER / unknown)
    h4_trend: 'UP' | 'DOWN' | 'n/a'; // EMA20 vs EMA50 on H4 at entry time
    with_trend: boolean | null; // did the position side agree with the H4 trend?
    exit_kind: 'SL' | 'TP' | 'other' | 'n/a'; // deduced from close price vs stored SL/TP
    hold_min: number | null; // holding time in minutes
    entry_reason: string | null; // why we entered (gold bot orders)
    playbook: string | null;
    archive_file: string | null; // TA context of the round that opened it
    risk_profile: string | null; // risk profile at entry (orders placed before profiles existed: null)
    config_hash: string | null; // id of the exact configuration at entry (see round-context.ts)
}

/**
 * Trade post-mortem: pulls real closed deals from cTrader (source of truth),
 * tags each with the strategy from the Mongo order log, and compares the
 * position side against the H4 EMA20/50 trend at entry time — so you can see
 * per trade whether it fought the same TA the bot pulls.
 */
@Injectable()
export class GoldHistoryService {
    private readonly logger = new Logger(GoldHistoryService.name);

    constructor(
        private configService: ConfigService,
        private ctraderService: CtraderService,
        private ordersService: OrdersService,
        private instruments: GoldInstrumentService,
    ) {}

    /** ประวัติของตราสารที่เลือกอยู่ (default) หรือระบุโปรไฟล์เอง — deals กรองตาม symbolId */
    async history(days: number, profile: InstrumentProfile = this.instruments.active) {
        if (!this.ctraderService.isAuthorized) throw new DomainError('cTrader not authorized');
        const symbolId = await this.instruments.resolveSymbolId(profile);
        const now = Date.now();
        const from = now - days * 86_400_000;
        const num = (v: any) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));

        // 1) closed deals, chunked by 1 week (API limit per request)
        const deals: any[] = [];
        for (let t = from; t < now; t += WEEK_MS) {
            const res = await this.ctraderService.getDealList(t, Math.min(t + WEEK_MS, now));
            deals.push(...((res?.deal ?? []) as any[]));
        }
        // เฉพาะ deal ของตราสารนี้ (deal ที่ไม่มี symbolId — ไม่ควรมี — นับรวมไว้เหมือนเดิม)
        const closes = deals.filter(
            (d) => d.closePositionDetail && (d.symbolId == null || num(d.symbolId) === symbolId),
        );

        // 2) H4 bars covering the whole span (+ warmup for EMA50) for trend tagging
        let h4: ReturnType<typeof enrich> = [];
        try {
            const res = await this.ctraderService.request<any>(
                'ProtoOAGetTrendbarsReq',
                {
                    ctidTraderAccountId: this.ctraderService.activeAccountId,
                    fromTimestamp: from - 250 * INTERVAL_MS['4h'],
                    toTimestamp: now,
                    period: CTRADER_PERIOD['4h'],
                    symbolId,
                },
                30_000,
            );
            const bars: Bar[] = ((res?.trendbar ?? []) as any[])
                .map((b) => {
                    const low = num(b.low) / PRICE_DIVISOR;
                    return {
                        ts: num(b.utcTimestampInMinutes) * 60_000,
                        open: low + num(b.deltaOpen) / PRICE_DIVISOR,
                        high: low + num(b.deltaHigh) / PRICE_DIVISOR,
                        low,
                        close: low + num(b.deltaClose) / PRICE_DIVISOR,
                        volume: num(b.volume),
                    };
                })
                .sort((a, b) => a.ts - b.ts);
            if (bars.length > 60) h4 = enrich(bars);
        } catch (e) {
            this.logger.warn(`H4 trend fetch failed (${errorMessage(e)}) — trend column = n/a`);
        }
        const trendAt = (ts: number): 'UP' | 'DOWN' | 'n/a' => {
            for (let i = h4.length - 1; i >= 0; i--) {
                if (h4[i].ts <= ts) return h4[i].ema20 > h4[i].ema50 ? 'UP' : 'DOWN';
            }
            return 'n/a';
        };

        // 3) join the Mongo order log via positionId (strategy + entry context)
        const posIds = [...new Set(closes.map((d) => num(d.positionId)))];
        const orders = await this.ordersService.findByPositionIds(posIds);
        const orderByPos = new Map<number, any>();
        for (const o of orders as any[]) {
            if (o.positionId) orderByPos.set(Number(o.positionId), o);
        }

        // 4) rows
        const rows: TradeRow[] = closes
            .map((d) => {
                const det = d.closePositionDetail;
                const divisor = Math.pow(10, num(d.moneyDigits) || 2);
                const gross = num(det.grossProfit) / divisor;
                const net = (num(det.grossProfit) + num(det.commission) + num(det.swap)) / divisor;
                // the closing deal's side is opposite to the position side
                const closeSide = num(d.tradeSide) === 1 ? 'BUY' : 'SELL';
                const side: 'BUY' | 'SELL' = closeSide === 'BUY' ? 'SELL' : 'BUY';
                const entryTs = num(det.entryTimestamp) || num(d.createTimestamp) || num(d.executionTimestamp);
                const closeTs = num(d.executionTimestamp);
                const trend = trendAt(entryTs);
                const order = orderByPos.get(num(d.positionId));
                const closePx = num(d.executionPrice);
                // how did it exit? compare close price against the SL/TP we stored
                let exitKind: TradeRow['exit_kind'] = 'n/a';
                if (order?.stopLoss || order?.takeProfit) {
                    // spread/slippage tolerance: ทอง $0.6 / FX 6 pips (ขั้นต่ำ) หรือ 0.04% ของราคา
                    const tol = Math.max(profile.pip * 6, closePx * 0.0004);
                    if (order.stopLoss && Math.abs(closePx - order.stopLoss) <= tol) exitKind = 'SL';
                    else if (order.takeProfit && Math.abs(closePx - order.takeProfit) <= tol) exitKind = 'TP';
                    else exitKind = 'other';
                }
                return {
                    closed_utc: new Date(closeTs).toISOString(),
                    position_id: num(d.positionId),
                    side,
                    lots: num(d.volume) / (profile.unitsPerLot * 100), // deal volume = units*100; XAU: 1000 -> 0.1 lot
                    entry: num(det.entryPrice),
                    close: closePx,
                    gross_usd: Math.round(gross * 100) / 100,
                    net_usd: Math.round(net * 100) / 100,
                    strategy: order?.strategy || order?.mode || 'unknown',
                    h4_trend: trend,
                    with_trend: trend === 'n/a' ? null : (trend === 'UP') === (side === 'BUY'),
                    exit_kind: exitKind,
                    hold_min: entryTs && closeTs ? Math.round((closeTs - entryTs) / 60_000) : null,
                    entry_reason: order?.reason || order?.message || null,
                    playbook: order?.playbookRef || null,
                    archive_file: order?.archiveFile || null,
                    risk_profile: order?.riskProfile || null,
                    config_hash: order?.configHash || null,
                };
            })
            .sort((a, b) => b.closed_utc.localeCompare(a.closed_utc));

        // 5) summary
        const sum = (xs: TradeRow[]) => Math.round(xs.reduce((s, r) => s + r.net_usd, 0) * 100) / 100;
        const agg = (xs: TradeRow[]) => ({
            trades: xs.length,
            wins: xs.filter((r) => r.net_usd > 0).length,
            losses: xs.filter((r) => r.net_usd < 0).length,
            winrate: xs.length ? Math.round((xs.filter((r) => r.net_usd > 0).length / xs.length) * 100) : 0,
            net_usd: sum(xs),
        });
        const byStrategy: Record<string, any> = {};
        for (const s of new Set(rows.map((r) => r.strategy))) {
            byStrategy[s] = agg(rows.filter((r) => r.strategy === s));
        }
        const bySide: Record<string, any> = {
            BUY: agg(rows.filter((r) => r.side === 'BUY')),
            SELL: agg(rows.filter((r) => r.side === 'SELL')),
        };

        return {
            days,
            instrument: profile.key,
            account_mode: this.configService.get<string>('CTRADER_ACCOUNT_MODE', 'DEMO').toUpperCase(),
            summary: agg(rows),
            with_h4_trend: agg(rows.filter((r) => r.with_trend === true)),
            against_h4_trend: agg(rows.filter((r) => r.with_trend === false)),
            by_strategy: byStrategy,
            by_side: bySide,
            trades: rows,
        };
    }
}
