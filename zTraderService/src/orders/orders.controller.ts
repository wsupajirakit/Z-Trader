import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyAuth } from '../common/auth/auth.decorators';
import { MachineAudited } from '../gold/http/machine-audit';
import { CreateOrderDto } from './dto/create-order.dto';
import { ExecutionService } from '../execution/execution.service';
import { OrdersService } from './orders.service';
import { CtraderService } from '../ctrader/ctrader.service';
import { errorStack } from '../common/utils/errors';

const PAGE_SIZE = 20;
const MAX_PAGE = 10_000;

/** a query parameter sent twice arrives as an array; this API takes single values only */
function singleQuery(v: unknown, name: string): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > 40) throw new BadRequestException(`${name} must be a single short value`);
    return v;
}

// machine API: zTraderActor places orders and reads history with x-api-key
@Controller()
@ApiKeyAuth()
export class OrdersController {
    private readonly logger = new Logger(OrdersController.name);

    constructor(
        private readonly executionService: ExecutionService,
        private readonly ordersService: OrdersService,
        private readonly ctraderService: CtraderService,
        private readonly config: ConfigService,
    ) {}

    @Get('history/stat')
    async getHistoryStat(@Query('mode') modeParam?: unknown) {
        const mode = singleQuery(modeParam, 'mode');
        // 1. Check if the requested mode is current and authorized
        const currentMode = (this.config.get<string>('CTRADER_ACCOUNT_MODE') || 'DEMO').toUpperCase();
        const isAdminRequest = !mode || mode.toUpperCase() === currentMode;

        if (isAdminRequest && this.ctraderService && this.ctraderService.isAuthorized) {
            try {
                // Fetch deals for the last 24 hours from cTrader
                const now = new Date();
                const utc7Offset = 7 * 60 * 60 * 1000;
                const localNow = new Date(now.getTime() + utc7Offset);
                const fromTimestamp =
                    Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - utc7Offset;
                const toTimestamp = now.getTime();
                const dealsRes = await this.ctraderService.getDealList(fromTimestamp, toTimestamp);

                let win = 0;
                let lose = 0;
                let pnl = 0;

                if (dealsRes && dealsRes.deal) {
                    const deals = dealsRes.deal as any[];
                    for (const deal of deals) {
                        if (deal.closePositionDetail) {
                            const detail = deal.closePositionDetail;
                            const moneyDigits = deal.moneyDigits || 2;
                            const divisor = Math.pow(10, moneyDigits);
                            const gross = this.getSafeVal(detail.grossProfit);
                            const comm = this.getSafeVal(detail.commission);
                            const swap = this.getSafeVal(detail.swap);
                            const result = (gross + comm + swap) / divisor;

                            if (result > 0) win++;
                            else if (result < 0) lose++;
                            pnl += result;
                        }
                    }
                }
                return { win, lose, pnl: Number(pnl.toFixed(2)), source: 'ctrader' };
            } catch (error) {
                this.logger.error('Failed to fetch stats from cTrader, falling back to database', errorStack(error));
            }
        }

        // 2. Fallback: Database-only stats (Last 24h)
        const orders = await this.ordersService.findToday(mode);
        let win = 0;
        let lose = 0;
        let pnl = 0;

        await Promise.all(
            orders.map(async (order) => {
                const enriched = await this.enrichOrderWithWinLose(order);
                const result = enriched.winLoseResult;
                if (result !== null) {
                    if (result > 0) win++;
                    else if (result < 0) lose++;
                    pnl += result;
                }
            }),
        );

        return { win, lose, pnl: Number(pnl.toFixed(2)), source: 'database' };
    }

    private getSafeVal(v: any): number {
        if (typeof v === 'number') return v;
        if (v && typeof v.low !== 'undefined') return v.low;
        return 0;
    }

    @Get('history')
    async getHistory(@Query('page') pageParam?: unknown, @Query('mode') modeParam?: unknown) {
        // page is clamped, not rejected: ?page=-1 or ?page=abc used to reach Mongo as a negative skip
        const page = Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(singleQuery(pageParam, 'page'))) || 1));
        const orders = await this.ordersService.findAll(page, PAGE_SIZE, singleQuery(modeParam, 'mode'));
        return Promise.all(orders.map((order) => this.enrichOrderWithWinLose(order)));
    }

    private async enrichOrderWithWinLose(order: any) {
        const orderObj = order.toObject ? order.toObject() : order;
        const raw = orderObj.rawResponse;
        let winLoseResult: number | null = null;

        const getVal = (v: any) => this.getSafeVal(v);

        // 1. Try to get from stored rawResponse
        if (raw && raw.deal && raw.deal.closePositionDetail) {
            const detail = raw.deal.closePositionDetail;
            const moneyDigits = raw.deal.moneyDigits || 2;
            const divisor = Math.pow(10, moneyDigits);
            const gross = getVal(detail.grossProfit);
            const comm = getVal(detail.commission);
            const swap = getVal(detail.swap);
            winLoseResult = (gross + comm + swap) / divisor;
        }

        // 2. Fallback: If no result yet but we have a positionId, try fetching from cTrader
        if (winLoseResult === null && raw) {
            const pId = raw.position?.positionId || raw.order?.positionId;
            const positionId = getVal(pId);

            if (positionId && positionId > 0 && this.ctraderService) {
                try {
                    const dealsRes = await this.ctraderService.getDealsByPositionId(positionId);
                    if (dealsRes && dealsRes.deal) {
                        const closingDeal = (dealsRes.deal as any[]).find((d) => d.closePositionDetail);
                        if (closingDeal) {
                            const detail = closingDeal.closePositionDetail;
                            const moneyDigits = closingDeal.moneyDigits || 2;
                            const divisor = Math.pow(10, moneyDigits);
                            const gross = getVal(detail.grossProfit);
                            const comm = getVal(detail.commission);
                            const swap = getVal(detail.swap);
                            winLoseResult = (gross + comm + swap) / divisor;
                        }
                    }
                } catch (e) {
                    // Ignore fetch errors
                }
            }
        }

        return {
            ...orderObj,
            winLoseResult,
            winLoseResultRaw: raw,
        };
    }

    @Post('orders')
    @HttpCode(HttpStatus.ACCEPTED)
    @MachineAudited('order.create', 'uuid')
    async execute(@Body() order: CreateOrderDto) {
        const active = this.ctraderService.activeAccountId;
        // null passes @IsOptional, so treat it like an absent field (!= null covers both)
        if (order.accountId != null && order.accountId !== active) {
            throw new BadRequestException('accountId does not match the account this service trades on');
        }
        // the insert is the idempotency check: uuid is a unique index, so two concurrent requests
        // with the same uuid cannot both get through (the old middleware did find-then-act)
        try {
            await this.ordersService.createOrder({ ...order, status: 'PENDING' });
        } catch (e) {
            if (e instanceof ConflictException) {
                throw new ConflictException('Duplicate UUID: Order already exists or is being processed.');
            }
            throw e;
        }
        // execution reports through order status + Telegram; the HTTP caller only needs the acceptance
        void this.executionService.executeOrder({ ...order, accountId: active });
        return { message: 'Order accepted and is being processed', uuid: order.uuid };
    }
}
