import { Body, Controller, Get, Logger, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AccountService } from '../account/account.service';
import { AuditService } from '../audit/audit.service';
import { CurrentSession, RequireRole } from '../common/auth/auth.decorators';
import type { SessionPrincipal } from '../common/auth/principal';
import { clientIp } from '../common/http/client-info';
import { errorMessage } from '../common/utils/errors';
import { CtraderService } from '../ctrader/ctrader.service';
import { GoldBuilderService } from '../gold/data/gold-builder.service';
import { GoldAutomateService } from '../gold/gold-automate.service';
import { GoldInstrumentService } from '../gold/gold-instrument.service';
import { GoldActivityService } from '../gold/records/gold-activity.service';
import { GoldArchiveService } from '../gold/records/gold-archive.service';
import { GoldHistoryService } from '../gold/records/gold-history.service';
import { toHttpError } from '../gold/http/http-errors';
import {
    ActivityQuery,
    ArchiveFileParams,
    ArchiveFileQuery,
    ArchiveListQuery,
    AutomateDto,
    DecisionDto,
    HistoryQuery,
    InstrumentDto,
    NewsQuery,
    RejectDto,
    RunDto,
    settingsBody,
} from './dto/dashboard.dto';

type Num = number | { toString(): string } | null | undefined;
const num = (v: Num) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));

/**
 * Everything the dashboard (web/) calls. Reads need any signed-in user; every action needs operator
 * and is written to the audit log with who did it.
 */
@Controller('api/dashboard')
export class DashboardController {
    private readonly logger = new Logger(DashboardController.name);

    constructor(
        private readonly automate: GoldAutomateService,
        private readonly builder: GoldBuilderService,
        private readonly archive: GoldArchiveService,
        private readonly history: GoldHistoryService,
        private readonly activity: GoldActivityService,
        private readonly ctrader: CtraderService,
        private readonly instruments: GoldInstrumentService,
        private readonly audit: AuditService,
        private readonly account: AccountService,
    ) {}

    // ---------------- reads (viewer) ----------------

    @Get('status')
    status() {
        return this.automate.getStatus();
    }

    /** balance of the connected cTrader account (status bar, % risk profiles) */
    @Get('account')
    accountSummary() {
        return this.account.summary();
    }

    @Get('modes')
    modes() {
        return this.builder.getModesInfo(this.instruments.active);
    }

    @Get('instruments')
    instrumentList() {
        return { active: this.instruments.activeKey, list: this.instruments.list() };
    }

    @Get('activity')
    activityFeed(@Query() q: ActivityQuery) {
        return { latest_id: this.activity.latestId(), entries: this.activity.since(q.after, 60) };
    }

    @Get('settings')
    getSettings() {
        return this.automate.getSettings();
    }

    @Get('news')
    news(@Query() q: NewsQuery) {
        return this.builder.fetchNews(q.limit, this.instruments.active);
    }

    @Get('archive')
    archiveList(@Query() q: ArchiveListQuery) {
        return this.archive.list(q.mode, q.limit);
    }

    @Get('archive/:mode/:file')
    async archiveRead(@Param() p: ArchiveFileParams, @Query() q: ArchiveFileQuery) {
        try {
            return await this.archive.read(`${p.mode}/${p.file}`, q.full === '1' || q.full === 'true');
        } catch (e) {
            // missing file = 404 with a generic message; the absolute path stays in the server log
            throw toHttpError(e, this.logger, 'GET archive/:mode/:file');
        }
    }

    @Get('positions')
    async positions() {
        if (!this.ctrader.isAuthorized) return [];
        // every instrument the bot knows (gold + FX); lots use each profile's unitsPerLot
        const res = await this.ctrader.getPositions();
        return ((res?.position ?? []) as any[])
            .map((p) => ({ p, prof: this.instruments.profileBySymbolId(num(p.tradeData?.symbolId)) }))
            .filter((x) => !!x.prof)
            .map(({ p, prof }) => ({
                positionId: num(p.positionId),
                symbol: prof!.key,
                digits: prof!.digits,
                side: num(p.tradeData?.tradeSide) === 1 ? 'BUY' : 'SELL',
                lots: num(p.tradeData?.volume) / (prof!.unitsPerLot * 100),
                entry: num(p.price),
                stopLoss: p.stopLoss ? num(p.stopLoss) : null,
                takeProfit: p.takeProfit ? num(p.takeProfit) : null,
                openedAt: num(p.tradeData?.openTimestamp) || null,
            }));
    }

    @Get('history')
    async tradeHistory(@Query() q: HistoryQuery) {
        try {
            return await this.history.history(q.days);
        } catch (e) {
            throw toHttpError(e, this.logger, 'GET history');
        }
    }

    /** Gemini 3.x+ models that are actually available (asked live, cached 1 h) */
    @Get('ai/models')
    aiModels() {
        return this.automate.listAiModels();
    }

    // ---------------- actions (operator, audited) ----------------

    @Post('instrument')
    @RequireRole('operator')
    setInstrument(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: InstrumentDto) {
        return this.act(s, req, 'dashboard.instrument', body.symbol, { ...body }, () =>
            this.automate.setInstrument(body.symbol),
        );
    }

    @Post('settings')
    @RequireRole('operator')
    saveSettings(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: unknown) {
        const settings = settingsBody(body);
        return this.act(s, req, 'settings.update', null, settings, () => this.automate.setSettings(settings));
    }

    @Post('daily-stop/reset')
    @RequireRole('operator')
    resetDailyStop(@CurrentSession() s: SessionPrincipal, @Req() req: Request) {
        return this.act(s, req, 'risk.daily_stop_reset', null, null, () => this.automate.resetDailyStop());
    }

    @Post('ai/reset-calls')
    @RequireRole('operator')
    resetAiCalls(@CurrentSession() s: SessionPrincipal, @Req() req: Request) {
        return this.act(s, req, 'ai.reset_calls', null, null, () => this.automate.resetAiCalls());
    }

    @Post('automate')
    @RequireRole('operator')
    setAutomate(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: AutomateDto) {
        const modes = body.modes?.length ? body.modes : undefined;
        return this.act(s, req, 'automate.set', null, { ...body }, () =>
            this.automate.setAutomate(body.enabled, modes, body.instruments),
        );
    }

    @Post('run')
    @RequireRole('operator')
    run(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: RunDto) {
        return this.act(s, req, 'trade.run', body.mode, { ...body }, () =>
            this.automate.runMode(body.mode, body.force === true, false),
        );
    }

    /** analyse and hold for review (same pipeline as the /gold-run skill) */
    @Post('analyze')
    @RequireRole('operator')
    analyze(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: RunDto) {
        return this.act(s, req, 'trade.analyze', body.mode, { ...body }, () =>
            this.automate.runMode(body.mode, body.force === true, true),
        );
    }

    @Post('confirm')
    @RequireRole('operator')
    confirm(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: DecisionDto) {
        return this.act(s, req, 'trade.confirm', body.id, { ...body }, () =>
            this.automate.confirmPending(body.mode, body.id),
        );
    }

    @Post('reject')
    @RequireRole('operator')
    reject(@CurrentSession() s: SessionPrincipal, @Req() req: Request, @Body() body: RejectDto) {
        const reason = body.reason ?? `Rejected from the dashboard (${s.user.username})`;
        return this.act(s, req, 'trade.reject', body.id, { ...body }, () => ({
            rejected: this.automate.rejectPending(body.mode, body.id, reason),
        }));
    }

    /**
     * Runs an operator action and records it in the audit log either way. What the caller sees of a
     * failure (see toHttpError): an HttpException unchanged, a DomainError (the operator broke a rule)
     * as a 400 with its message, anything else as a generic 500 with the stack in the server log.
     */
    private async act<T>(
        s: SessionPrincipal,
        req: Request,
        action: string,
        target: string | null,
        detail: Record<string, unknown> | null,
        fn: () => T | Promise<T>,
    ): Promise<T> {
        const base = { actor: s.user, action, target, ip: clientIp(req), detail };
        try {
            const result = await fn();
            await this.audit.record({ ...base, success: true });
            return result;
        } catch (e) {
            await this.audit.record({ ...base, success: false, detail: { ...detail, error: errorMessage(e) } });
            throw toHttpError(e, this.logger, action);
        }
    }
}
