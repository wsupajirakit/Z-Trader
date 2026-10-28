import { Body, Controller, Get, Logger, Param, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiKeyAuth } from '../common/auth/auth.decorators';
import { GoldAutomateService } from './gold-automate.service';
import { GoldBuilderService } from './data/gold-builder.service';
import { GoldArchiveService } from './records/gold-archive.service';
import { GoldHistoryService } from './records/gold-history.service';
import { GoldActivityService } from './records/gold-activity.service';
import { GoldInstrumentService } from './gold-instrument.service';
import { GoldGeminiService } from './ai/gold-gemini.service';
import { GoldMode } from './data/gold-data.service';
import {
    ArchiveFileParams,
    ArchiveFileQuery,
    AutomateDto,
    DecisionDto,
    InstrumentDto,
    MachineRunDto,
    RejectDto,
    settingsBody,
    VALID_MODES,
} from './dto/gold.dto';
import { toHttpError } from './http/http-errors';
import { MachineAudited } from './http/machine-audit';

// machine API: every /gold route needs x-api-key (the dashboard uses /api/dashboard with a session).
// Bodies use the same DTOs as the dashboard; every write is audited (actor null, detail.via = 'api-key').
@ApiKeyAuth()
@Controller('gold')
export class GoldController {
    private readonly logger = new Logger(GoldController.name);

    constructor(
        private readonly goldAutomateService: GoldAutomateService,
        private readonly goldBuilderService: GoldBuilderService,
        private readonly goldArchiveService: GoldArchiveService,
        private readonly goldHistoryService: GoldHistoryService,
        private readonly activity: GoldActivityService,
        private readonly instruments: GoldInstrumentService,
        private readonly gemini: GoldGeminiService,
    ) {}

    // ---------------- ตราสาร (ทอง / คู่เงิน) ----------------

    /** รายการตราสารที่รองรับ + ตัวที่เลือกอยู่: GET /gold/instruments */
    @Get('instruments')
    getInstruments() {
        return { active: this.instruments.activeKey, list: this.instruments.list() };
    }

    /** เปลี่ยนตราสาร (ต้องหยุด loop ก่อน): POST /gold/instrument { "symbol": "EURUSD" } */
    @Post('instrument')
    @MachineAudited('instrument.set', 'symbol')
    setInstrument(@Body() body: InstrumentDto) {
        try {
            return this.goldAutomateService.setInstrument(body.symbol);
        } catch (e) {
            throw toHttpError(e, this.logger, 'POST /gold/instrument');
        }
    }

    /** ดู prompt ที่ AI assist จะได้รับสำหรับตราสาร+โหมดนี้: GET /gold/ai/prompt?mode=swing */
    @Get('ai/prompt')
    aiPrompt(@Query('mode') modeParam?: string) {
        const mode = this.parseMode(modeParam);
        const profile = this.instruments.active;
        return {
            instrument: profile.key,
            mode,
            config: this.gemini.config,
            system_prompt: this.gemini.buildSystemPrompt(profile, mode),
        };
    }

    /** ถ้าผู้เรียกระบุ symbol มาด้วย ให้สลับตราสารก่อน (โยน error ถ้า loop ยังเปิด) */
    private applySymbol(symbol?: string) {
        if (!symbol) return;
        if (symbol.toUpperCase() === this.instruments.activeKey) return;
        try {
            this.goldAutomateService.setInstrument(symbol);
        } catch (e) {
            throw toHttpError(e, this.logger, 'switch instrument');
        }
    }

    /**
     * Trade post-mortem: GET /gold/history?days=30 — closed deals from cTrader
     * + strategy/entry-reason/archive join from Mongo + H4-trend comparison
     */
    @Get('history')
    async history(@Query('days') daysParam?: string) {
        const days = Math.max(1, Math.min(365, parseInt(daysParam ?? '30', 10) || 30));
        try {
            return await this.goldHistoryService.history(days);
        } catch (e) {
            throw toHttpError(e, this.logger, 'GET /gold/history');
        }
    }

    @Get('status')
    getStatus() {
        return this.goldAutomateService.getStatus();
    }

    /** activity feed สำหรับ dashboard: GET /gold/activity?after=<lastId> */
    @Get('activity')
    activityFeed(@Query('after') after?: string) {
        const afterId = Math.max(0, parseInt(after ?? '0', 10) || 0);
        return {
            latest_id: this.activity.latestId(),
            entries: this.activity.since(afterId, 60),
        };
    }

    @Get('modes')
    getModes() {
        return this.goldBuilderService.getModesInfo(this.instruments.active);
    }

    /** ข่าวล่าสุดสำหรับคน/Claude อ่านประกอบการตัดสิน (TA engine ไม่ใช้): GET /gold/news?limit=20 */
    @Get('news')
    async news(@Query('limit') limitParam?: string) {
        const limit = Math.max(1, Math.min(50, parseInt(limitParam ?? '20', 10) || 20));
        return this.goldBuilderService.fetchNews(limit, this.instruments.active);
    }

    /**
     * Pull + build the data set and return it as JSON (no ZIP):
     * GET /gold/data?mode=swing&bars=50  — series trimmed to the last N bars
     */
    @Get('data')
    async data(@Query('mode') modeParam: string, @Query('bars') barsParam?: string) {
        const mode = this.parseMode(modeParam);
        const tail = Math.max(1, Math.min(1000, parseInt(barsParam ?? '50', 10) || 50));
        const d = await this.goldAutomateService.getData(mode);
        const series: Record<string, any> = {};
        for (const [k, bars] of Object.entries(d.series ?? {})) {
            series[k] = {
                bars: bars.length,
                last_ts_utc: new Date(bars[bars.length - 1].ts).toISOString(),
                tail: bars.slice(-tail),
            };
        }
        return {
            mode,
            generated_utc: new Date().toISOString(),
            generated_bangkok: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }),
            cache_hit: d.cacheHit,
            errors: d.errors,
            series,
        };
    }

    /** ประวัติรอบที่เก็บไว้: GET /gold/archive?mode=swing&limit=20 */
    @Get('archive')
    getArchive(@Query('mode') mode?: string, @Query('limit') limit?: string) {
        const m = mode ? this.parseMode(mode) : undefined;
        return this.goldArchiveService.list(m, Math.max(1, Math.min(200, parseInt(limit ?? '50', 10) || 50)));
    }

    /** อ่านไฟล์ประวัติ (สรุป): GET /gold/archive/swing/xxx.json · เพิ่ม ?full=1 เพื่อดูแท่งย้อนหลังด้วย */
    @Get('archive/:mode/:file')
    async readArchive(@Param() p: ArchiveFileParams, @Query() q: ArchiveFileQuery) {
        try {
            return await this.goldArchiveService.read(`${p.mode}/${p.file}`, q.full === '1' || q.full === 'true');
        } catch (e) {
            throw toHttpError(e, this.logger, 'GET /gold/archive/:mode/:file');
        }
    }

    /** ค่าความเสี่ยงปัจจุบัน: GET /gold/settings */
    @Get('settings')
    getSettings() {
        return this.goldAutomateService.getSettings();
    }

    /** ตั้งค่าความเสี่ยงจาก dashboard: POST /gold/settings { risk_usd_per_trade, daily_max_loss_usd, ... } */
    @Post('settings')
    @MachineAudited('settings.update')
    setSettings(@Body() body: unknown) {
        const settings = settingsBody(body);
        try {
            return this.goldAutomateService.setSettings(settings);
        } catch (e) {
            throw toHttpError(e, this.logger, 'POST /gold/settings');
        }
    }

    /** เปิด/ปิด loop อัตโนมัติจาก dashboard: POST /gold/automate { "enabled": true, "modes": ["swing"] } */
    /** รีเซ็ตโควตาการเรียก AI ของวันนี้ */
    /** POST /gold/daily-stop/reset — ปลดด่านกันขาดทุนรายวันด้วยมือ (เริ่มนับใหม่จากตอนนี้) */
    /** รายชื่อรุ่น Gemini 3.x+ ที่ใช้ได้จริง (ถาม Google ตอนเรียก แคช 1 ชม.) */
    @Get('ai/models')
    async aiModels() {
        return this.goldAutomateService.listAiModels();
    }

    @Post('daily-stop/reset')
    @MachineAudited('risk.daily_stop_reset')
    resetDailyStop() {
        return this.goldAutomateService.resetDailyStop();
    }

    @Post('ai/reset-calls')
    @MachineAudited('ai.reset_calls')
    resetAiCalls() {
        return this.goldAutomateService.resetAiCalls();
    }

    @Post('automate')
    @MachineAudited('automate.set')
    setAutomate(@Body() body: AutomateDto) {
        // ตราสารที่ loop จะวนเทรดพร้อมกัน — เลือกได้กี่ตัวก็ได้ ไม่ส่งมา = คงค่าเดิม
        const modes = body.modes?.length ? body.modes : undefined;
        return this.goldAutomateService.setAutomate(body.enabled, modes, body.instruments);
    }

    /**
     * ท่ออัตโนมัติ/ยิงตรง: POST /gold/run { "mode": "swing", "force": true }
     * TA ตัดสิน + ยิง order ทันที (flow เดิม)
     */
    @Post('run')
    @MachineAudited('trade.run', 'mode')
    async run(@Body() body: MachineRunDto) {
        this.applySymbol(body.symbol);
        return this.goldAutomateService.runMode(body.mode, body.force === true, false);
    }

    // ---------------- ท่อแยกสำหรับ Claude (skill gold-run) ----------------
    // analyze = TA คิด+พัก order รอตรวจ · confirm/reject = ผลตรวจของ Claude

    /** POST /gold/claude/analyze { "mode": "swing", "force": true } → outcome "awaiting-approval:<id>" */
    @Post('claude/analyze')
    @MachineAudited('trade.analyze', 'mode')
    async claudeAnalyze(@Body() body: MachineRunDto) {
        this.applySymbol(body.symbol);
        return this.goldAutomateService.runMode(body.mode, body.force === true, true);
    }

    /** POST /gold/claude/confirm { "mode": "swing", "id": "ab12cd34" } → ยิง order ที่พักไว้ */
    @Post('claude/confirm')
    @MachineAudited('trade.confirm', 'id')
    async claudeConfirm(@Body() body: DecisionDto) {
        try {
            return await this.goldAutomateService.confirmPending(body.mode, body.id);
        } catch (e) {
            throw toHttpError(e, this.logger, 'POST /gold/claude/confirm');
        }
    }

    /** POST /gold/claude/reject { "mode": "swing", "id": "...", "reason": "..." } → ปัดตก */
    @Post('claude/reject')
    @MachineAudited('trade.reject', 'id')
    claudeReject(@Body() body: RejectDto) {
        const ok = this.goldAutomateService.rejectPending(body.mode, body.id, body.reason ?? 'no reason given');
        return { rejected: ok };
    }

    private parseMode(value?: unknown): GoldMode {
        // ?mode=a&mode=b arrives as an array
        if (value !== undefined && typeof value !== 'string')
            throw new BadRequestException('mode must be a single value');
        const mode = (value ?? 'swing').toLowerCase() as GoldMode;
        if (!VALID_MODES.includes(mode)) {
            throw new BadRequestException(`mode must be one of ${VALID_MODES.join(', ')}`);
        }
        return mode;
    }
}
