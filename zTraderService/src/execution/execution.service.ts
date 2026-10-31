import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CtraderService } from '../ctrader/ctrader.service';
import { OrdersService } from '../orders/orders.service';
import { TelegramService } from '../telegram/telegram.service';
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../common/utils/errors';
import { demoContext } from '../common/demo/demo-context';
@Injectable()
export class ExecutionService {
    private readonly logger = new Logger(ExecutionService.name);

    private trackedScalperPositions: Map<
        number,
        {
            symbolId: number;
            side: 'BUY' | 'SELL';
            entryPrice: number;
            breakevenMoved: boolean;
            trailingActivated: boolean;
            lastTrailingSl: number;
            pipsFactor: number;
        }
    > = new Map();

    constructor(
        private ctraderService: CtraderService,
        private ordersService: OrdersService,
        private telegramService: TelegramService,
    ) {}

    async executeOrder(orderParams: any, retryCount = 0) {
        demoContext.assertNotDemo('Placing an order');
        const { uuid } = orderParams;

        try {
            this.logger.log(`Executing order for UUID: ${uuid}, Attempt: ${retryCount + 1}`);

            // Update status to PROCESSING
            await this.ordersService.updateOrderStatus(uuid, 'PROCESSING');

            // Map Order Type to cTrader Enum
            // MARKET = 1, LIMIT = 2, STOP = 3, STOP_LIMIT = 4
            const orderTypeMap: Record<string, number> = {
                MARKET: 1,
                LIMIT: 2,
                STOP: 3,
                STOP_LIMIT: 4,
            };

            // Resolve symbolId — ผู้เรียกที่รู้ symbolId แล้ว (gold bot ผ่าน instrument profile) ส่งมาได้เลย
            const accountId = orderParams.accountId || this.ctraderService.activeAccountId;
            let symbolId: number;
            if (Number.isFinite(Number(orderParams.symbolId)) && Number(orderParams.symbolId) > 0) {
                symbolId = Number(orderParams.symbolId);
            } else {
                const symbolsListRes = await this.ctraderService.request<any>('ProtoOASymbolsListReq', {
                    ctidTraderAccountId: accountId,
                    includeArchivedSymbols: false,
                });
                const symbolInfo = symbolsListRes?.symbol?.find((s: any) => s.symbolName === orderParams.symbol);
                if (!symbolInfo) {
                    throw new Error(`Symbol ${orderParams.symbol} not found in cTrader`);
                }
                symbolId = Number(symbolInfo.symbolId);
            }

            // Map symbol to lot size in units
            const getUnitsPerLot = (symbol: string) => {
                if (
                    symbol.includes('JPY') ||
                    symbol.includes('EUR') ||
                    (symbol.includes('USD') && !symbol.includes('XAU') && !symbol.includes('BTC'))
                )
                    return 100000;
                if (symbol.includes('XAU')) return 100;
                if (symbol.includes('BTC')) return 1;
                return 100; // Default
            };

            // ขนาด lot: ใช้ค่าจาก instrument profile ถ้าส่งมา (ทอง 100 · FX 100,000) ไม่งั้นเดาจากชื่อ
            const unitsPerLot =
                Number(orderParams.unitsPerLot) > 0
                    ? Number(orderParams.unitsPerLot)
                    : getUnitsPerLot(orderParams.symbol);
            // ProtoOANewOrderReq.volume is in CENTS of units (units × 100):
            // XAUUSD 0.01 lot = 1 oz -> 100. The old code omitted the ×100, so
            // every order was 100x smaller than the requested lot size.
            const volumeUnits = Math.round(orderParams.volume * unitsPerLot * 100);

            const payload: any = {
                ctidTraderAccountId: accountId,
                symbolId: symbolId,
                volume: volumeUnits,
                orderType: orderTypeMap[orderParams.orderType] || 1,
                tradeSide: orderParams.side === 'BUY' ? 1 : 2,
                // ต้องส่ง clientOrderId ทุกครั้ง — ตัวกรอง "ยกเลิกไม้ค้างของโหมดเดิม"
                // ใน gold-automate อ่านฟิลด์นี้เพื่อหาว่า pending order ไหนเป็นของเรา
                // ไม่ส่ง = ฟิลด์ว่างกลับมา = ตัวกรองไม่เจออะไรเลย = ออเดอร์ซ้อนกัน
                // (26 ส.ค.: scalp วาง SELL LIMIT ราคาเดียวกัน 3 ไม้ ห่างกัน 5 นาที
                //  แล้ว fill พร้อมกันหมด — กฎ "หนึ่ง pending ต่อโหมด" ไม่เคยทำงานเลย)
                clientOrderId: String(uuid).slice(0, 50), // cTrader จำกัด 50 ตัวอักษร
            };

            // Add Price for non-market orders — cTrader rejects a LIMIT order
            // carrying stopPrice (and vice versa), so set only the relevant field
            if (orderParams.orderType !== 'MARKET' && orderParams.price) {
                if (orderParams.orderType === 'LIMIT') {
                    payload.limitPrice = orderParams.price;
                } else if (orderParams.orderType === 'STOP') {
                    payload.stopPrice = orderParams.price;
                } else {
                    payload.limitPrice = orderParams.price;
                    payload.stopPrice = orderParams.price; // STOP_LIMIT
                }
            }

            // Add Stop Loss and Take Profit
            if (orderParams.orderType === 'MARKET') {
                if (orderParams.relativeStopLoss) {
                    payload.relativeStopLoss = orderParams.relativeStopLoss;
                } else if (orderParams.stopLoss && orderParams.price) {
                    // CTrader measures relative SL/TP in multiples of 10^-5 (100000) for standard precision
                    payload.relativeStopLoss = Math.round(Math.abs(orderParams.price - orderParams.stopLoss) * 100000);
                }

                if (orderParams.relativeTakeProfit) {
                    payload.relativeTakeProfit = orderParams.relativeTakeProfit;
                } else if (orderParams.takeProfit && orderParams.price) {
                    payload.relativeTakeProfit = Math.round(
                        Math.abs(orderParams.price - orderParams.takeProfit) * 100000,
                    );
                }
            } else {
                if (orderParams.stopLoss) payload.stopLoss = orderParams.stopLoss;
                if (orderParams.takeProfit) payload.takeProfit = orderParams.takeProfit;
            }

            // Add Expiration for pending orders (requires GOOD_TILL_DATE)
            if (orderParams.expirationTimestamp) {
                payload.expirationTimestamp = orderParams.expirationTimestamp;
                payload.timeInForce = 1; // ProtoOATimeInForce.GOOD_TILL_DATE
            }

            // Send order request via Protobuf
            this.ctraderService.send('ProtoOANewOrderReq', payload, uuid);
        } catch (error) {
            if (retryCount < 3) {
                const delay = Math.pow(2, retryCount) * 1000;
                this.logger.warn(`Order failed, retrying in ${delay / 1000}s...`);
                setTimeout(() => void this.executeOrder(orderParams, retryCount + 1), delay);
            } else {
                this.logger.error(`Order failed after 3 retries for UUID: ${uuid}`);
                await this.ordersService.updateOrderStatus(uuid, 'FAILED', { message: errorMessage(error) });
                await this.telegramService.notifyError(
                    `Critical Error: Order ${uuid} failed after 3 retries. Error: ${errorMessage(error)}`,
                );
            }
        }
    }

    @OnEvent('ctrader.execution')
    async handleExecutionEvent(payload: any) {
        // Log all responses to order.log
        try {
            const logPath = path.join(process.cwd(), 'order.log');
            const logLine = `[${new Date().toISOString()}] ${JSON.stringify(payload)}\n`;
            fs.appendFileSync(logPath, logLine, { encoding: 'utf8' });
        } catch (e) {
            this.logger.error(`Failed to write to order.log: ${errorMessage(e)}`);
        }

        const uuid = payload.clientMsgId;
        if (!uuid) return;

        const executionType = payload.executionType;

        try {
            const positionId = payload.position?.positionId ? Number(payload.position.positionId) : undefined;
            const orderId = payload.order?.orderId ? Number(payload.order.orderId) : undefined;
            const identifiers = { ...(positionId && { positionId }), ...(orderId && { orderId }) };

            switch (executionType) {
                case 2: // ORDER_ACCEPTED
                case 'ORDER_ACCEPTED':
                    this.logger.log(`Order ${uuid} accepted (Type: ${executionType})`);
                    await this.ordersService.updateOrderStatus(uuid, 'SUCCESS', {
                        rawResponse: payload,
                        ...identifiers,
                    });
                    break;
                case 'ORDER_FILLED': {
                    const entryPrice = payload.order?.executionPrice || payload.position?.price || 0;
                    this.logger.log(`Order ${uuid} FILLED at ${entryPrice} (Type: ${executionType})`);

                    const orderDoc = await this.ordersService.findByUuid(uuid);
                    if (orderDoc && orderDoc.strategy === 'SCALPER' && positionId) {
                        const side = payload.order?.tradeData?.tradeSide === 1 ? 'BUY' : 'SELL';
                        this.trackedScalperPositions.set(positionId, {
                            symbolId: Number(payload.order?.tradeData?.symbolId || 41),
                            side: side,
                            entryPrice: entryPrice,
                            breakevenMoved: false,
                            trailingActivated: false,
                            lastTrailingSl: 0,
                            pipsFactor: 0.01, // Assuming strictly XAUUSD Scalper
                        });
                        this.logger.log(`[SCALPER] Tracking active position ${positionId} for dynamic SL.`);
                    }

                    if (payload.position?.positionStatus === 'POSITION_STATUS_CLOSED') {
                        if (positionId) this.trackedScalperPositions.delete(positionId);
                    }

                    await this.ordersService.updateOrderStatus(uuid, 'SUCCESS', {
                        rawResponse: payload,
                        entryPrice,
                        ...identifiers,
                    });
                    break;
                }
                case 4: // ORDER_REJECTED
                case 'ORDER_REJECTED':
                    this.logger.error(`Order ${uuid} rejected by cTrader. Code: ${payload.errorCode}`);
                    await this.ordersService.updateOrderStatus(uuid, 'FAILED', {
                        rawResponse: payload,
                        message: payload.errorCode,
                    });
                    break;
            }
        } catch (error) {
            this.logger.error(`Failed to update order status for ${uuid}: ${errorMessage(error)}`);
        }
    }

    @OnEvent('indicators.updated')
    async handleIndicatorsUpdate(payload: any) {
        if (this.trackedScalperPositions.size === 0) return;

        const { symbolId, bid, ask } = payload;

        for (const [positionId, pos] of this.trackedScalperPositions.entries()) {
            if (pos.symbolId !== symbolId) continue;

            const currentPrice = pos.side === 'BUY' ? bid : ask;
            const pnlPips =
                pos.side === 'BUY'
                    ? (currentPrice - pos.entryPrice) / pos.pipsFactor
                    : (pos.entryPrice - currentPrice) / pos.pipsFactor;

            // 1. Breakeven +40 pips -> move SL to +5 pips
            if (pnlPips >= 40 && !pos.breakevenMoved) {
                const newSl =
                    pos.side === 'BUY' ? pos.entryPrice + 5 * pos.pipsFactor : pos.entryPrice - 5 * pos.pipsFactor;
                try {
                    await this.ctraderService.amendPositionSLTP(positionId, Number(newSl.toFixed(5)), undefined);
                    pos.breakevenMoved = true;
                    this.logger.log(`[SCALPER] Breakeven trigger (+40p). Pos ${positionId} SL moved to ${newSl}`);
                } catch (e) {
                    this.logger.error(`[SCALPER] Failed to move BE for ${positionId}: ${errorMessage(e)}`);
                }
            }

            // 2. Trailing Stop +50 pips -> Trail 30 pips behind
            if (pnlPips >= 50) {
                const trailSl =
                    pos.side === 'BUY' ? currentPrice - 30 * pos.pipsFactor : currentPrice + 30 * pos.pipsFactor;

                const isBetterSl =
                    pos.lastTrailingSl === 0 ||
                    (pos.side === 'BUY' ? trailSl > pos.lastTrailingSl : trailSl < pos.lastTrailingSl);

                const diffPips =
                    pos.lastTrailingSl === 0 ? 30 : Math.abs(trailSl - pos.lastTrailingSl) / pos.pipsFactor;

                if (isBetterSl && diffPips >= 5) {
                    try {
                        await this.ctraderService.amendPositionSLTP(positionId, Number(trailSl.toFixed(5)), undefined);
                        pos.lastTrailingSl = trailSl;
                        this.logger.log(
                            `[SCALPER] Trailing step (+${pnlPips.toFixed(1)}p). Pos ${positionId} SL moved to ${trailSl}`,
                        );
                    } catch (e) {
                        this.logger.error(`[SCALPER] Failed to trail SL for ${positionId}: ${errorMessage(e)}`);
                    }
                }
            }
        }
    }
}
