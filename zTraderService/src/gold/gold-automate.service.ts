import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { CtraderService } from '../ctrader/ctrader.service';
import { ExecutionService } from '../execution/execution.service';
import { OrdersService } from '../orders/orders.service';
import { TelegramService } from '../telegram/telegram.service';
import { GoldDataService, GoldExport, GoldMode } from './data/gold-data.service';
import { GoldBuilderService } from './data/gold-builder.service';
import { GoldTaService } from './analysis/gold-ta.service';
import { GoldArchiveService } from './records/gold-archive.service';
import { GoldActivityService } from './records/gold-activity.service';
import { DealCacheService } from './records/deal-cache.service';
import {
    appVersion,
    newTrace,
    withoutSecrets,
    type ConfigSnapshot,
    type RoundSizing,
    type RoundTrace,
} from './records/round-context';
import { INTERVAL_MS } from './domain/gold-modes';
import { marketStatus } from './domain/market-hours';
import { OnEvent } from '@nestjs/event-emitter';
import { GoldAiService, GoldDecision, GoldSize } from './ai/gold-ai.service';
import { GoldGeminiService, GoldAiAssist, GoldAiProposal } from './ai/gold-gemini.service';
import { EnrichedBar } from './domain/indicators';
import { GoldInstrumentService } from './gold-instrument.service';
import {
    InstrumentProfile,
    INSTRUMENTS,
    INSTRUMENT_KEYS,
    type InstrumentKey,
    isInstrumentKey,
    fmtPrice,
    roundPrice,
    seriesKey,
    usdPerUnitMovePerLot,
} from './domain/instruments';
import { errorMessage } from '../common/utils/errors';
import { DomainError } from './domain/domain-error';
import { demoContext } from '../common/demo/demo-context';
import { AI_STRICTNESS_LEVELS, type AiStrictness, STRICTNESS_MIN_AI_CONFIDENCE } from './ai/ai-strictness';

/** off = TA only · assist = TA, then the AI confirms/vetoes · lead = assist + the AI proposes when TA finds nothing · ai_only = the AI decides every round */
export const AI_MODES = ['off', 'assist', 'lead', 'ai_only'] as const;
export type AiMode = (typeof AI_MODES)[number];
export type AiProvider = 'gemini' | 'claude';

/** marker of the risk profile applied last, persisted with the other overrides (GOLD_RISK_PROFILE) */
export interface RiskProfileMarker {
    id: string;
    name: string;
    /** the settings body the profile resolved to when applied; any later difference = "modified" */
    applied: Record<string, number>;
}

interface ModeConfig {
    periodMin: number; // bar period the loop is aligned to (XAU_AUTOMATE.md §7)
    offsetSec: number; // wait after bar close before pulling (server needs the closed bar)
    rrMin: number; // minimum R:R at TP1 (§4)
}

const MODE_CFG: Record<GoldMode, ModeConfig> = {
    scalp: { periodMin: 5, offsetSec: 10, rrMin: 1.5 },
    intraday: { periodMin: 15, offsetSec: 15, rrMin: 1.8 },
    swing: { periodMin: 60, offsetSec: 20, rrMin: 2.0 },
    position: { periodMin: 1440, offsetSec: 0, rrMin: 2.5 }, // runs at GOLD_POSITION_RUN_UTC_HOURS instead
};

// Session windows are defined in New York time (ET) so they survive DST —
// research: gold volume/volatility peaks in the London–NY overlap 08:00-12:00 ET,
// US data lands 08:30 ET, liquidity dies after London close (~12:00 ET)

export interface ModeState {
    lastRunAt: string | null;
    lastBarBucket: number;
    lastDecision: GoldDecision | null;
    lastAssist?: import('./ai/gold-gemini.service').GoldAiAssist | null;
    lastOutcome: string | null; // what the bot did with the decision
    lastError: string | null;
}

/** a trade decision parked for a second-opinion review before execution */
interface PendingApproval {
    id: string;
    decision: GoldDecision;
    sizeCap: GoldSize | null;
    createdAt: number;
    /** configuration of the round that parked it; carried onto the order when it is fired */
    trace?: RoundTrace;
}

const PENDING_TTL_MS = 10 * 60_000; // decision goes stale after 10 minutes
const TA_MAX_CONFIDENCE = 8; // max confidence the TA engine can actually produce (see gold-ta.service.ts confBase)
const STALE_TICK_MS = 90_000; // market open but price unchanged for 90 s = silent subscription
const SPOT_RESUB_COOLDOWN_MS = 60_000; // avoid re-subscribing on every tick

@Injectable()
export class GoldAutomateService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(GoldAutomateService.name);
    private timer: NodeJS.Timeout | null = null;
    private beTimer: NodeJS.Timeout | null = null;
    // per-position management state: breakeven done + last SL we set (for trailing)
    private posMgr = new Map<number, { be: boolean; lastSl: number }>();
    private pnlCache: { value: number; ts: number } | null = null;
    /**
     * จุดที่กด "เคลียร์ daily stop" — นับขาดทุนใหม่ตั้งแต่เวลานี้ (ไม่ใช่ปิดด่านทิ้ง)
     * ผูก day ไว้ด้วย พอข้ามวัน UTC ให้ถือว่าหมดอายุเอง ไม่ค้างข้ามวัน
     */
    private dailyStopReset: { day: string; ts: number } | null = null;
    private lastSpotResubAt = new Map<string, number>(); // key = instrument -> last resubscribe attempt (throttle per instrument)
    // นับ scalp ต่อวัน แยกตามตราสาร (key = instrument)
    private scalpCount = new Map<string, { day: string; count: number }>();
    // สมัครรับราคาสดของหลายตราสารพร้อมกันได้ (loop วนหลายตราสาร) — key = instrument key
    private spotSubscribed = new Map<string, boolean>();
    private spotSymbolId = new Map<string, number>(); // instrument key -> symbolId subscribed for live prices
    private lastHeartbeat = 0;
    private currentMode: GoldMode | null = null;
    private marketWasOpen = new Map<string, boolean>(); // key = instrument -> was that market open last tick (hours differ per instrument)
    // state/pending/running แยกตามตราสาร: key = `${instrument}:${mode}` — สลับตราสารแล้วของเดิมไม่หาย
    private running = new Set<string>();
    private state = new Map<string, ModeState>();
    private pending = new Map<string, PendingApproval>();
    private lastPositionRunDate = new Map<string, string>(); // key = instrument -> date of the last position run
    // runtime overrides (from POST /gold/automate) — null = follow env
    private runtimeEnabled: boolean | null = null;
    private runtimeModes: GoldMode[] | null = null;
    private runtimeInstruments: string | null = null; // comma-separated keys, null = only the active instrument

    constructor(
        private configService: ConfigService,
        private ctraderService: CtraderService,
        private executionService: ExecutionService,
        private ordersService: OrdersService,
        private telegramService: TelegramService,
        private goldDataService: GoldDataService,
        private goldBuilderService: GoldBuilderService,
        private goldAiService: GoldAiService,
        private goldGeminiService: GoldGeminiService,
        private goldTaService: GoldTaService,
        private goldArchiveService: GoldArchiveService,
        private activity: GoldActivityService,
        private instruments: GoldInstrumentService,
        private deals: DealCacheService,
    ) {}

    /** โปรไฟล์ตราสารที่เลือกอยู่ (ทอง/คู่เงิน) */
    get profile(): InstrumentProfile {
        return this.instruments.active;
    }

    private sk(mode: GoldMode, p: InstrumentProfile = this.profile): string {
        return `${p.key}:${mode}`;
    }

    /** ข้อมูลตราสารสำหรับ status/settings/dashboard */
    private instrumentInfo(p: InstrumentProfile = this.profile) {
        return {
            key: p.key,
            name_th: p.name_th,
            emoji: p.emoji,
            kind: p.kind,
            digits: p.digits,
            pip: p.pip,
            units_per_lot: p.unitsPerLot,
            quote_ccy: p.quoteCcy,
            symbol_id: this.instruments.cachedSymbolId(p),
        };
    }

    /**
     * เปลี่ยนตราสารที่บอทเทรด — ทำได้เฉพาะตอน loop หยุดและไม่มีรอบวิเคราะห์ค้าง
     * (ราคาสด/state/pending ของตราสารเดิมยังเก็บไว้ สลับกลับมาได้)
     */
    setInstrument(symbol: string) {
        demoContext.assertNotDemo('Switching the instrument');
        if (this.isEnabled()) throw new DomainError('Stop the Auto Loop before changing the instrument');
        if (this.running.size)
            throw new DomainError(
                'An analysis round is running — wait for it to finish before changing the instrument',
            );
        const before = this.profile.key;
        const p = this.instruments.setActive(symbol);
        if (p.key !== before) {
            // ไม่ต้องล้าง tick/subscription/marketWasOpen อีกต่อไป — ทุกอย่างเป็น Map
            // แยกตามตราสารอยู่แล้ว (key = instrument key) สลับไปสลับมาไม่ชนกันเอง
            // และราคา/สถานะของตราสารเดิมยังอยู่ครบ สลับกลับมาใช้ต่อได้ทันทีตามคอมเมนต์ข้างบน
            this.activity.push(
                'warn',
                `${p.emoji} Instrument changed to ${p.key} (${p.name_th}) — data/playbook/AI prompt/news/market hours updated accordingly`,
            );
        }
        return this.getStatus();
    }

    // ---------- live price (spot subscription) ----------
    // ราคาสดของแต่ละตราสาร — key = instrument key (เช่น "XAUUSD")
    // Map แทน field เดี่ยวเพราะ loop วนหลายตราสารพร้อมกันได้ (enabledInstruments())
    // และ applyAssist/applyProposal ต้องเทียบ entry กับราคาตลาด "ของตราสารที่กำลังวิเคราะห์"
    // ไม่ใช่ราคาที่ค้างมาจากตราสารอื่นที่ tick รอบก่อนบังเอิญไปแตะ
    private ticks = new Map<string, { bid: number; ask: number; at: number }>();

    @OnEvent('ctrader.spot')
    onSpot(payload: any) {
        const num = (v: any) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));
        const symbolId = num(payload?.symbolId);
        // เก็บ tick ของทุกตราสารที่ระบบรู้จัก (ไม่ใช่กรองทิ้งเฉพาะตัวที่ active) — loop
        // วนหลายตราสารพร้อมกัน แต่ละตัวต้องมีราคาสดของตัวเองไว้ใช้ตอนวิเคราะห์
        const prof = this.instruments.profileBySymbolId(symbolId);
        if (!prof) return; // unknown symbol (e.g. extra klines gateway subscription), not for the gold bot
        const bid = num(payload.bid) / 100_000;
        const ask = num(payload.ask) / 100_000;
        if (bid > 0) this.ticks.set(prof.key, { bid, ask: ask || bid, at: Date.now() });
    }

    /** ราคาสดของตราสารที่ระบุ — ไม่ระบุ = ตัว active ปัจจุบัน (พฤติกรรมเดิม) */
    getLastTick(p: InstrumentProfile = this.profile) {
        return this.ticks.get(p.key) ?? null;
    }

    /**
     * ดูแล subscription ราคาสดให้มีชีวิตอยู่เสมอ
     *
     * เดิม `spotSubscribed` เป็น latch ที่ตั้งครั้งเดียวแล้วไม่เคยรีเซ็ต — พอ
     * subscription เงียบไป (WS ต่อใหม่ หรือ broker ตัดฝั่ง server) ก็ไม่มีอะไร
     * สมัครใหม่ให้ ราคาบน dashboard ค้างแช่ไปเรื่อย ๆ
     * (เจอจริง 15 ส.ค. 69: ราคาค้าง 2 ชม. 41 นาที แต่ log ยังวิ่งปกติ)
     */
    /** วนสมัครราคาสดของทุกตราสารที่เปิดใช้งาน (ไม่ใช่แค่ตัว active เดียว) */
    private async ensureSpotSubscription() {
        if (!this.ctraderService.isAuthorized || !this.ctraderService.connected) {
            // socket หลุด/ไม่ auth = subscription ทุกตัวตายไปกับ session เดิม รอ reconnect แล้วสมัครใหม่หมด
            this.spotSubscribed.clear();
            return;
        }
        for (const p of this.enabledInstruments()) {
            await this.ensureSpotSubscriptionFor(p);
        }
    }

    /**
     * สมัครราคาสด "ของตราสารเดียว" — แยกจาก ensureSpotSubscription() เพื่อให้ loop
     * หลายตราสารเรียกซ้ำได้โดยไม่ต้องเขียน logic ซ้ำ (เดิม `spotSubscribed` เป็น latch
     * ตัวเดียวที่ตั้งครั้งเดียวแล้วไม่เคยรีเซ็ต — พอ subscription เงียบไปก็ไม่มีอะไรสมัครใหม่ให้
     * ราคาบน dashboard ค้างแช่ไปเรื่อย ๆ (เจอจริง 15 ส.ค. 69: ราคาค้าง 2 ชม. 41 นาที))
     *
     * ไม่มีเรื่อง "เปลี่ยนตราสารต้อง unsubscribe ตัวเก่า" อีกต่อไป เพราะตอนนี้ทุกตราสาร
     * ที่เปิดใช้งานถูก subscribe ค้างไว้พร้อมกันหมด ไม่มีการ "สลับ" ในความหมายเดิม
     */
    private async ensureSpotSubscriptionFor(p: InstrumentProfile) {
        let symbolId: number;
        try {
            symbolId = await this.instruments.resolveSymbolId(p);
        } catch (e) {
            // หา symbolId ไม่ได้ (เช่น broker ไม่มีคู่นี้) — แจ้งครั้งเดียวต่อ cooldown แล้วรอรอบหน้า
            const last = this.lastSpotResubAt.get(p.key) ?? 0;
            if (Date.now() - last > SPOT_RESUB_COOLDOWN_MS) {
                this.lastSpotResubAt.set(p.key, Date.now());
                this.activity.push('error', `Could not find the symbolId for ${p.key}: ${errorMessage(e)}`);
            }
            return;
        }

        const tick = this.ticks.get(p.key);
        const tickAge = tick ? Date.now() - tick.at : 0;
        // ตลาดเปิดแต่ราคาไม่ขยับเลย = subscription เงียบ ต้องรื้อสมัครใหม่
        const stale =
            (this.spotSubscribed.get(p.key) ?? false) &&
            tick != null &&
            tickAge > STALE_TICK_MS &&
            marketStatus(new Date(), p.hours).open &&
            Date.now() - (this.lastSpotResubAt.get(p.key) ?? 0) > SPOT_RESUB_COOLDOWN_MS;

        if (stale) {
            this.logger.warn(
                `Live price for ${p.key} stale for ${Math.round(tickAge / 60_000)} min — tearing down and re-subscribing`,
            );
            this.activity.push(
                'warn',
                `⚠ Live price for ${p.key} stale for ${Math.round(tickAge / 60_000)} min — re-subscribing to prices`,
            );
            // ต้อง unsubscribe ก่อน ไม่งั้น server ตอบ ALREADY_SUBSCRIBED แล้วราคาก็ยังค้าง
            try {
                await this.ctraderService.unsubscribeSpots(symbolId, 'gold', true);
            } catch {
                /* ไม่เป็นไร สมัครใหม่ต่อได้ */
            }
            this.spotSubscribed.set(p.key, false);
        }
        if (this.spotSubscribed.get(p.key)) return;

        this.lastSpotResubAt.set(p.key, Date.now());
        try {
            await this.ctraderService.subscribeSpots(symbolId, 'gold');
            this.spotSubscribed.set(p.key, true);
            this.spotSymbolId.set(p.key, symbolId);
            this.activity.push('ok', `Subscribed to live ${p.key} prices from cTrader`);
        } catch (e) {
            // already subscribed by the klines gateway = fine, ticks still arrive
            if (/ALREADY/i.test((e as { errorCode?: string } | null)?.errorCode ?? errorMessage(e))) {
                this.spotSubscribed.set(p.key, true);
                this.spotSymbolId.set(p.key, symbolId);
            }
        }
    }

    onModuleInit() {
        this.restoreOverrides();
        this.logger.log(
            this.isEnabled()
                ? `Gold automate enabled for modes: ${this.enabledModes().join(', ')}`
                : 'Gold automate disabled (start via POST /gold/automate or GOLD_AUTOMATE_ENABLED=true)',
        );
        // timer always runs; tick() checks isEnabled() so the loop can be
        // started/stopped at runtime from the dashboard. 5s cadence so the
        // dashboard always has fresh activity to show.
        this.timer = setInterval(() => {
            this.tick().catch((e) => {
                this.logger.error(errorMessage(e));
                this.activity.push('error', `tick error: ${errorMessage(e)}`);
            });
        }, 5_000);
        this.activity.push('info', 'Gold service started — waiting for signals');
        // breakeven manager runs regardless of the loop switch — protects any
        // open GOLD_AI position (research: gold retraces hard; lock at +1R)
        this.beTimer = setInterval(() => {
            this.manageOpenPositions().catch((e) => this.logger.error(errorMessage(e)));
        }, 60_000);
    }

    // ---------- AI assist ----------

    /**
     * escape ข้อความที่มาจาก AI/ข่าว ก่อนส่งเข้า Telegram (parse_mode=HTML)
     * ตัว < > & ที่หลุดไปจะทำให้ Telegram ปฏิเสธทั้งข้อความ = ออเดอร์จริงยิงไปแล้ว
     * แต่ไม่มีใครได้รับแจ้งเตือน
     */
    private esc(v: unknown): string {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- AI fields are strings/numbers; anything else is printed as-is on purpose
        return String(v ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** ห่อคำตอบ AI ให้อ่านออก — ใช้ทั้งใน Telegram และส่งขึ้นหน้าเว็บ */
    private assistLines(d: GoldDecision): string[] {
        const ai = (d as any).ai_assist as GoldAiAssist | undefined;
        if (!ai) return [];
        const mark =
            ai.verdict === 'CONFIRM'
                ? '✅ AI confirmed the original levels'
                : ai.verdict === 'ADJUST'
                  ? '✏️ AI adjusted the levels'
                  : '🛑 AI vetoed this trade';
        return [
            '',
            `🤖 <b>${mark}</b> (confidence ${ai.confidence}/10)`,
            ai.reason ? `• Reason: ${this.esc(ai.reason)}` : '',
            ai.key_levels ? `• Key levels: ${this.esc(ai.key_levels)}` : '',
            ai.risk_note ? `• ⚠ Risk: ${this.esc(ai.risk_note)}` : '',
            (ai as any).news_risk ? `• 📰 News/calendar: ${this.esc((ai as any).news_risk)}` : '',
            (ai as any).invalidation ? `• ❌ Invalidated if: ${this.esc((ai as any).invalidation)}` : '',
        ].filter(Boolean);
    }

    /** เปิด AI ช่วยหาจุดเข้าอยู่ไหม — สวิตช์จาก dashboard ทับค่า env GOLD_AI_ASSIST */
    /**
     * โหมด AI: off = ไม่ใช้ · assist = ตรวจไม้ที่ TA หามา (ลดความเสี่ยงได้อย่างเดียว)
     * · lead = assist + ถ้า TA ไม่เจอ setup ให้ AI หาไม้เอง (ผ่านด่านเข้มกว่า + ขนาดไม้ไม่เกินครึ่ง)
     * รองรับ GOLD_AI_ASSIST=true แบบเดิม = assist
     */
    aiMode(): AiMode {
        const raw = this.cfg('GOLD_AI_MODE', '').toLowerCase();
        const mode: AiMode = (AI_MODES as readonly string[]).includes(raw)
            ? (raw as AiMode)
            : this.cfg('GOLD_AI_ASSIST', 'false').toLowerCase() === 'true'
              ? 'assist'
              : 'off';
        if (mode === 'off') return 'off';
        const claude = mode === 'ai_only' && this.aiProvider() === 'claude';
        const hasKey = claude ? (this.goldAiService?.hasKey ?? false) : this.goldGeminiService.config.has_key;
        if (!hasKey) {
            const key = claude ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
            if (!this.assistKeyWarned) {
                this.assistKeyWarned = true;
                this.logger.warn(`AI mode=${mode} but ${key} is not set — falling back to TA only`);
                this.activity.push('warn', `AI mode is ${mode} but ${key} is not set — the bot is using TA only`);
            }
            return 'off';
        }
        return mode;
    }

    /** which vendor answers the AI-only mode (assist/lead are Gemini only) */
    aiProvider(): AiProvider {
        return this.cfg('GOLD_AI_PROVIDER', 'gemini').toLowerCase() === 'claude' ? 'claude' : 'gemini';
    }

    /** ta = rule-based analysis (with optional Gemini layers) · ai = Claude reads the data and decides alone */
    engine(): 'ta' | 'ai' {
        if (this.aiMode() === 'ai_only' && this.aiProvider() === 'claude') return 'ai';
        return (this.configService?.get<string>('GOLD_ENGINE', 'ta') ?? 'ta').toLowerCase() === 'ai' ? 'ai' : 'ta';
    }

    aiStrictness(): AiStrictness {
        const v = this.cfg('GOLD_AI_STRICTNESS', 'normal').toLowerCase();
        return (AI_STRICTNESS_LEVELS as readonly string[]).includes(v) ? (v as AiStrictness) : 'normal';
    }

    aiAssistEnabled(): boolean {
        return this.aiMode() !== 'off';
    }
    private assistKeyWarned = false;
    private aiQuotaWarnedDay = new Set<string>();

    /**
     * เอาความเห็น AI มาทับไม้ของ TA แบบมีกรอบ
     *
     * AI ขัดระดับได้ แต่ห้ามเปลี่ยนไม้เป็นคนละไม้ — ด่านที่กันไว้:
     *   - ขยับ entry เกิน 0.6% = ปฏิเสธ ใช้ของ TA (ถือว่าเป็นคนละไม้)
     *   - SL ต้องอยู่ฝั่งถูกต้องของ entry ตามทิศ ไม่งั้นใช้ของ TA
     *   - R:R หลังขยับต่ำกว่าขั้นต่ำ = ไม่เข้า
     *   - ขนาดไม้เอาค่าที่ "เล็กกว่า" ระหว่าง TA กับ AI เสมอ (AI เพิ่มไม้ไม่ได้)
     */
    /**
     * @param p ตราสารของไม้นี้ — ใช้หาราคาตลาดปัจจุบันที่ถูกต้องเทียบ entry ที่ AI ขยับมา
     *   ไม่ส่งมา = ใช้ตัว active ปัจจุบัน (พฤติกรรมเดิม ก่อนรองรับหลายตราสารพร้อมกัน)
     *   ต้องส่งมาชัดเจนเมื่อ loop วนหลายตราสาร ไม่งั้นจะเทียบราคาข้ามตราสารกันเอง
     *   (เช่นกำลังตรวจไม้ EURUSD แต่ this.profile ดันเป็น XAUUSD เพราะ active ถูกตั้งไว้ที่อื่น)
     */
    private applyAssist(
        ta: GoldDecision,
        ai: GoldAiAssist | null,
        rrMin: number,
        p: InstrumentProfile = this.profile,
    ): GoldDecision {
        if (!ai) return ta;
        const d: GoldDecision = { ...ta, ai_assist: ai };

        if (ai.verdict === 'VETO') {
            return {
                ...d,
                order_type: 'NO_TRADE',
                entry: null,
                sl: null,
                tp1: null,
                tp2: null,
                rr_tp1: null,
                reason: `AI veto: ${ai.reason || 'no reason given'}`,
            };
        }

        const minAi = STRICTNESS_MIN_AI_CONFIDENCE[this.aiStrictness()];
        if (minAi != null && (ai.confidence ?? 0) < minAi) {
            return {
                ...d,
                order_type: 'NO_TRADE',
                entry: null,
                sl: null,
                tp1: null,
                tp2: null,
                rr_tp1: null,
                reason: `AI confidence ${ai.confidence ?? 0}/10 is below the ${this.aiStrictness()} strictness threshold ${minAi} — no trade`,
            };
        }

        const isBuy = ta.order_type.startsWith('BUY');
        const entry = ai.entry ?? ta.entry;
        const sl = ai.sl ?? ta.sl;
        const tp1 = ai.tp1 ?? ta.tp1;
        const tp2 = ai.tp2 ?? ta.tp2;

        // ขนาดไม้: หยิบตัวที่เล็กกว่าเสมอ
        const rank: Record<GoldSize, number> = { quarter: 0, half: 1, full: 2 };
        const size: GoldSize = rank[ai.size] < rank[ta.size] ? ai.size : ta.size;
        // confidence: หยิบตัวที่ต่ำกว่าเสมอ (AI ลดได้ เพิ่มไม่ได้) — ต้องคิดตรงนี้คู่กับ size
        // เพราะทุกทางที่ return ก่อนถึงท้ายฟังก์ชัน (ขยับไกลเกิน / SL ผิดฝั่ง / SL แคบ-กว้างเกิน /
        // ไม่มีราคาสด) เดิมส่งแต่ size ไป = "AI บอกว่าไม้นี้น่ากลัวกว่าที่ TA คิด" หายไปเฉย ๆ
        // ทั้งที่เป็นข้อมูลลดความเสี่ยง ซึ่งต้องเก็บไว้เสมอตามกฎของระบบ
        const conf = ai.confidence != null ? Math.min(ta.confidence, ai.confidence) : ta.confidence;

        // ระดับไม่ครบ = ไม่ต้องขยับ
        if (entry == null || sl == null || tp1 == null || ta.entry == null) {
            return { ...d, size, confidence: conf };
        }
        // ขยับไกลเกิน = คนละไม้
        // เพดานต้องผูกกับ "ระยะ SL ของไม้นั้น" ไม่ใช่ % ของราคา — 0.6% ของทอง $4,350 = $26
        // ซึ่งกว้างกว่า SL ของ scalp ($6) ถึง 4 เท่า ด่านนี้จึงแทบไม่เคยทำงาน
        const taRiskForDrift = ta.entry != null && ta.sl != null ? Math.abs(ta.entry - ta.sl) : 0;
        const driftAbs = Math.abs(entry - ta.entry);
        const driftCap =
            taRiskForDrift > 0
                ? Math.min(taRiskForDrift * 0.5, ta.entry * 0.006) // half the SL distance and at most 0.6%
                : ta.entry * 0.006;
        if (driftAbs > driftCap) {
            this.logger.warn(
                `[AI] entry moved ${driftAbs.toFixed(2)}, above the cap ${driftCap.toFixed(2)} ` +
                    `(half the SL distance ${taRiskForDrift.toFixed(2)}) — using the TA levels instead`,
            );
            return { ...d, size, confidence: conf };
        }
        // SL ผิดฝั่ง = ใช้ของ TA
        if ((isBuy && sl >= entry) || (!isBuy && sl <= entry)) {
            this.logger.warn('[AI] SL is on the wrong side of entry — using the TA levels instead');
            return { ...d, size, confidence: conf };
        }
        // R:R หลังขยับต้องยังคุ้ม
        const risk = Math.abs(entry - sl);
        const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
        if (rr < rrMin) {
            return {
                ...d,
                order_type: 'NO_TRADE',
                entry: null,
                sl: null,
                tp1: null,
                tp2: null,
                rr_tp1: null,
                reason: `After the AI adjustment R:R is ${rr.toFixed(2)}, below the minimum ${rrMin} — no trade`,
            };
        }

        // SL ต้องไม่แคบกว่าของ TA เกินครึ่ง — sizing แบบ risk คำนวณ lot จาก 1/ระยะ SL
        // AI บีบ SL แคบ = lot พองทวีคูณจนชน GOLD_MAX_LOT ทั้งที่ "เสี่ยงเท่าเดิม" บนกระดาษ
        const taRisk = ta.entry != null && ta.sl != null ? Math.abs(ta.entry - ta.sl) : 0;
        if (taRisk > 0 && risk < taRisk * 0.5) {
            this.logger.warn(
                `[AI] SL tightened from ${taRisk.toFixed(2)} to ${risk.toFixed(2)} (< half of TA) — using the TA levels instead`,
            );
            return { ...d, size, confidence: conf };
        }
        // ...และต้องไม่ถ่าง SL เกิน 2 เท่าของ TA ด้วย (เดิมคุมแค่ฝั่งแคบ)
        // ถ่าง SL = ระยะขาดทุนต่อไม้ยาวขึ้นจริง ๆ แม้ lot จะเล็กลงตามสูตร risk
        // applyProposal คุมสองฝั่งด้วย ATR อยู่แล้ว ทางนี้ซึ่งใช้บ่อยกว่ากลับไม่มีเพดานบน
        if (taRisk > 0 && risk > taRisk * 2) {
            this.logger.warn(
                `[AI] SL widened from ${taRisk.toFixed(2)} to ${risk.toFixed(2)} (> 2x TA) — using the TA levels instead`,
            );
            return { ...d, size, confidence: conf };
        }
        // entry ที่ขยับต้องยังอยู่ถูกฝั่งของราคาตลาดตามชนิดออเดอร์
        // (BUY_LIMIT ต้องต่ำกว่าตลาด · BUY_STOP ต้องสูงกว่า — ไม่งั้น broker ปฏิเสธหรือกลายเป็นไม้คนละแบบ)
        // ใช้ราคาของตราสาร p (ไม้นี้จริง ๆ) ไม่ใช่ตัว active เฉย ๆ — กันเทียบราคาข้ามตราสาร
        // ไม่มีราคาสด / ราคาค้างเกิน STALE_TICK_MS = ตรวจฝั่งไม่ได้จริง
        // เดิม "ข้ามด่านไปเลย" = ด่านปิดตัวเองเงียบ ๆ ตอนที่ feed ตาย ซึ่งเป็นตอนที่ต้องการมันที่สุด
        // ตอนนี้ตรวจไม่ได้ = ไม่รับระดับใหม่ของ AI ใช้ของ TA แทน (ยังเทรดต่อ ไม่ได้หยุดระบบ)
        const tk = this.getLastTick(p);
        const tickAge = tk ? Date.now() - tk.at : Infinity;
        if (!tk || tickAge > STALE_TICK_MS) {
            this.logger.warn(
                `[AI] no reliable live price for ${p.key} (${tk ? Math.round(tickAge / 1000) + ' s' : 'no tick'}) ` +
                    '— cannot check the order side, using the TA levels instead',
            );
            return { ...d, size, confidence: conf };
        }
        const mkt = isBuy ? tk.ask : tk.bid;
        {
            const wantBelow = ta.order_type === 'BUY_LIMIT' || ta.order_type === 'SELL_STOP';
            const ok = wantBelow ? entry < mkt : entry > mkt;
            if (!ok) {
                this.logger.warn(
                    `[AI] entry ${entry} is on the wrong side of the market price ${mkt} for ${ta.order_type} — using the TA levels instead`,
                );
                return { ...d, size, confidence: conf };
            }
        }

        const moved = entry !== ta.entry || sl !== ta.sl || tp1 !== ta.tp1;
        // confidence: AI "ลดได้ เพิ่มไม่ได้" — ไม่งั้น AI จะเป็นคนพาไม้ข้ามด่าน
        // GOLD_MIN_CONFIDENCE เองซึ่งเป็นด่านสุดท้ายก่อนยิงจริง
        return {
            ...d,
            entry,
            sl,
            tp1,
            tp2,
            size,
            rr_tp1: Number(rr.toFixed(2)),
            confidence: conf,
            reason: moved ? `${ta.reason} | AI adjusted levels: ${ai.reason}` : `${ta.reason} | AI confirmed`,
        };
    }

    /**
     * แปลง "ไม้ที่ AI หามาเอง" (โหมด lead) เป็น GoldDecision — หรือคืน NO_TRADE ถ้าไม่ผ่านด่าน
     *
     * ไม้นี้ไม่มี TA ยืนยัน จึงต้องเข้มกว่า assist ทุกทาง:
     *   - ขนาดไม้ไม่เกินครึ่ง (และไม่เกิน sizeCap ที่ตัวคุมความเสี่ยงสั่งมา)
     *   - confidence ไม่เกินเพดานที่ TA ทำได้ (8) เพื่อให้เจอด่าน GOLD_MIN_CONFIDENCE เท่าเทียมกัน
     *   - ต้องอ้าง playbook · R:R ต้องถึงขั้นต่ำของโหมด · SL/TP ต้องถูกฝั่ง
     *   - SL ต้องกว้างพอไม่ให้ไส้เทียนเขี่ย และไม่กว้างเกินจนเสี่ยงเกินงบ (ATR เป็นเกณฑ์)
     *   - entry ต้องถูกฝั่งของราคาตลาดตามชนิดออเดอร์ (ไม่งั้น broker ปฏิเสธ/กลายเป็นไม้คนละแบบ)
     * ผ่านแล้วยังต้องไปเจอด่านเดิมทั้งหมดต่อ (validateDecision → min confidence → risk budget)
     */
    private applyProposal(
        pr: GoldAiProposal | null,
        rrMin: number,
        sizeCap: GoldSize | null,
        p: InstrumentProfile,
        series: Record<string, EnrichedBar[]> | null,
        mode: GoldMode,
        origin: 'lead' | 'ai_only' = 'lead',
    ): GoldDecision {
        const no = (reason: string): GoldDecision => ({
            order_type: 'NO_TRADE',
            entry: null,
            sl: null,
            tp1: null,
            tp2: null,
            rr_tp1: null,
            confidence: 0,
            size: 'quarter',
            valid_until_utc: null,
            invalidation: '',
            playbook_ref: '',
            reason,
            analysis_summary: reason,
        });

        if (!pr)
            return no(`AI (${origin === 'ai_only' ? 'AI only' : 'lead'} mode) did not answer this round — no trade`);
        if (pr.action !== 'TRADE') {
            return no(`AI found no setup: ${pr.reason || 'no reason given'}`);
        }
        const minAi = STRICTNESS_MIN_AI_CONFIDENCE[this.aiStrictness()];
        if (minAi != null && pr.confidence < minAi) {
            return no(
                `AI confidence ${pr.confidence}/10 is below the ${this.aiStrictness()} strictness threshold ${minAi} — no trade`,
            );
        }
        const { entry, sl, tp1 } = pr;
        if (entry == null || sl == null || tp1 == null)
            return no('AI proposed a trade but the price levels are incomplete');

        const isBuy = pr.order_type.startsWith('BUY');
        if ((isBuy && sl >= entry) || (!isBuy && sl <= entry)) {
            return no(`AI proposed ${pr.order_type} but SL is on the wrong side of entry — trade dropped`);
        }
        if ((isBuy && tp1 <= entry) || (!isBuy && tp1 >= entry)) {
            return no(`AI proposed ${pr.order_type} but TP1 is on the wrong side of entry — trade dropped`);
        }

        const risk = Math.abs(entry - sl);
        const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
        if (rr < rrMin)
            return no(`AI proposed a trade with R:R ${rr.toFixed(2)}, below the minimum ${rrMin} — no trade`);

        // SL ต้องสมเหตุผลเทียบความผันผวนจริง: แคบไปโดนไส้เทียนเขี่ย · กว้างไปเสี่ยงเกินงบ
        const atr = this.execAtr(p, mode, series);
        if (atr && atr > 0) {
            if (risk < atr * 0.3) {
                return no(
                    `AI placed a tight SL ${fmtPrice(p, risk)} (< 0.3×ATR ${fmtPrice(p, atr)}) — wicks will surely tag it, trade dropped`,
                );
            }
            if (risk > atr * 3) {
                return no(
                    `AI placed a wide SL ${fmtPrice(p, risk)} (> 3×ATR ${fmtPrice(p, atr)}) — not worth the risk, trade dropped`,
                );
            }
        }

        // entry ต้องถูกฝั่งของราคาตลาดตามชนิดออเดอร์ — ราคาของตราสาร p นี้ ไม่ใช่ตัว active
        // ไม่มีราคาสด/ค้าง = ตรวจฝั่งไม่ได้ · ไม้นี้ AI หาเองล้วน (ไม่มี TA ยืนยัน) จึงทิ้งไปเลย
        const tk = this.getLastTick(p);
        const tickAge = tk ? Date.now() - tk.at : Infinity;
        if (!tk || tickAge > STALE_TICK_MS) {
            return no(
                `No reliable live price for ${p.key} (${tk ? Math.round(tickAge / 1000) + ' s' : 'no tick'}) — cannot check the order side, trade dropped`,
            );
        }
        {
            const mkt = isBuy ? tk.ask : tk.bid;
            const wantBelow = pr.order_type === 'BUY_LIMIT' || pr.order_type === 'SELL_STOP';
            if (wantBelow ? entry >= mkt : entry <= mkt) {
                return no(
                    `AI proposed ${pr.order_type} at ${fmtPrice(p, entry)}, on the wrong side of the market price ${fmtPrice(p, mkt)} — trade dropped`,
                );
            }
        }

        // ขนาดไม้: ไม่มี TA ยืนยัน = ไม่เกินครึ่ง และเคารพ sizeCap ที่สั่งมา
        const rank: Record<GoldSize, number> = { quarter: 0, half: 1, full: 2 };
        let size: GoldSize = rank[pr.size] > rank.half ? 'half' : pr.size;
        if (sizeCap && rank[sizeCap] < rank[size]) size = sizeCap;

        const cfgMode = MODE_CFG[mode];
        return {
            order_type: pr.order_type,
            entry,
            sl,
            tp1,
            tp2: pr.tp2,
            rr_tp1: Number(rr.toFixed(2)),
            // เทียบเท่าเพดานของ TA เพื่อให้ผ่านด่าน min_confidence ด้วยมาตรฐานเดียวกัน
            confidence: Math.min(TA_MAX_CONFIDENCE, pr.confidence),
            size,
            valid_until_utc: new Date(Date.now() + (cfgMode?.periodMin ?? 60) * 60_000 * 3).toISOString(),
            invalidation: pr.invalidation || '',
            playbook_ref: pr.playbook_ref,
            reason: `${origin === 'ai_only' ? 'AI only' : 'AI found the trade (lead)'}: ${pr.reason}`,
            analysis_summary: [
                origin === 'ai_only'
                    ? '🤖 AI-only mode: this trade was found by the AI'
                    : '🤖 This trade comes from the AI, not TA (TA found no setup this round)',
                `playbook: ${pr.playbook_ref}`,
                pr.key_levels ? `Key levels: ${pr.key_levels}` : '',
                pr.risk_note ? `Risk: ${pr.risk_note}` : '',
                pr.news_risk ? `News: ${pr.news_risk}` : '',
            ]
                .filter(Boolean)
                .join('\n'),
            ai_assist: pr as any,
        } as GoldDecision;
    }

    /** ATR14 ของ TF สั่งการในโหมดนั้น — ใช้ตรวจว่า SL ที่ AI วางสมเหตุผลไหม */
    private execAtr(p: InstrumentProfile, mode: GoldMode, series: Record<string, EnrichedBar[]> | null): number | null {
        if (!series) return null;
        for (const { tf } of p.modes[mode]?.sets?.filter((x) => x.symbol === p.key) ?? []) {
            const bars = series[seriesKey(p, tf)];
            const last = bars?.[bars.length - 1];
            if (last?.atr14 && Number.isFinite(last.atr14) && last.atr14 > 0) return last.atr14;
        }
        return null;
    }

    // ---------- runtime risk settings (แก้จาก dashboard ได้ ทับค่าใน env) ----------
    private overrides = new Map<string, string>();

    /**
     * ไฟล์จำค่าที่ตั้งจาก dashboard — ต้องมี ไม่งั้นค่าความปลอดภัยหายทุกครั้งที่รีสตาร์ท
     *
     * เดิม overrides อยู่ใน memory ล้วน รีสตาร์ตทีเด้งกลับไปค่าใน .env ซึ่ง "อันตรายกว่า"
     * มาก (เจอจริง 31 ส.ค.: risk $30 -> $1,500 = 50 เท่า · daily stop $100 -> $4,000
     * · ไม้ค้าง 1 -> 20) โดยไม่มีอะไรเตือนเลย — ค่าที่ผู้ใช้ตั้งไว้เพื่อกันเจ๊งหายเงียบ ๆ
     * แล้วบอทเดินต่อด้วยเพดานที่หลวมกว่าหลายสิบเท่า
     *
     * เก็บเป็นไฟล์ ไม่ใช่ Mongo เพราะ Mongo ล่มแล้วทั้งแอปไม่ขึ้น (เจอมาแล้ว)
     * ค่าความปลอดภัยต้องไม่ผูกกับบริการที่ล้มได้
     */
    private get settingsFile(): string {
        return path.resolve(this.configService.get<string>('GOLD_SETTINGS_FILE', './data/runtime-settings.json'));
    }

    private persistOverrides() {
        demoContext.assertNotDemo('Saving settings');
        try {
            const f = this.settingsFile;
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify(Object.fromEntries(this.overrides), null, 2));
        } catch (e) {
            this.logger.error(`Failed to save settings (${errorMessage(e)}) — they will be lost on restart`);
        }
    }

    private restoreOverrides() {
        try {
            const f = this.settingsFile;
            if (!fs.existsSync(f)) return;
            const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
            for (const [k, v] of Object.entries(raw)) {
                if (typeof v === 'string') this.overrides.set(k, v);
            }
            // ค่าของ Gemini อยู่คนละ service ต้องยิงข้ามไปด้วย ไม่งั้นคืนมาแต่ไม่มีผล
            for (const k of ['GOLD_AI_THINKING', 'GEMINI_MODEL', 'GOLD_AI_STRICTNESS']) {
                const v = this.overrides.get(k);
                if (v) this.goldGeminiService.setRuntime(k, v);
            }
            for (const k of ['GOLD_AI_THINKING', 'GOLD_CLAUDE_MODEL', 'GOLD_AI_STRICTNESS']) {
                const v = this.overrides.get(k);
                if (v) this.goldAiService?.setRuntime?.(k, v);
            }
            if (this.overrides.size) {
                const shown = [
                    'GOLD_RISK_USD_PER_TRADE',
                    'GOLD_DAILY_MAX_LOSS_USD',
                    'GOLD_MAX_OPEN_POSITIONS',
                    'GOLD_MAX_LOT',
                ]
                    .filter((k) => this.overrides.has(k))
                    .map((k) => `${k}=${this.overrides.get(k)}`);
                this.logger.log(
                    `Restored settings from ${f} (${this.overrides.size} values)${shown.length ? ' · ' + shown.join(' · ') : ''}`,
                );
            }
        } catch (e) {
            this.logger.error(`Failed to read saved settings (${errorMessage(e)}) — using .env values instead`);
        }
    }

    /** อ่าน config โดยเช็ค override จาก dashboard ก่อน แล้วค่อย fallback ไป env */
    private cfg(key: string, fallback: string): string {
        return this.overrides?.get(key) ?? this.configService?.get<string>(key, fallback) ?? fallback;
    }

    getSettings() {
        return {
            risk_usd_per_trade: parseFloat(this.cfg('GOLD_RISK_USD_PER_TRADE', '1500')),
            daily_max_loss_usd: parseFloat(this.cfg('GOLD_DAILY_MAX_LOSS_USD', '4000')),
            max_open_positions: parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS', '20'), 10),
            max_open_positions_total: parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS_TOTAL', '0'), 10),
            // สถานะ daily stop ให้ dashboard แสดง (pnl มาจากแคช อาจเป็น null ถ้ายังไม่เคยอ่าน)
            daily_pnl: this.pnlCache?.value ?? null,
            daily_stop_reset_at: this.activeDailyStopReset()?.ts
                ? new Date(this.activeDailyStopReset()!.ts).toISOString()
                : null,
            scalp_max_per_day: parseInt(this.cfg('GOLD_SCALP_MAX_PER_DAY', '40'), 10),
            min_confidence: parseInt(this.cfg('GOLD_MIN_CONFIDENCE', '7'), 10),
            max_lot: this.maxLotFor(INSTRUMENTS['XAUUSD']),
            // เพดาน lot ที่มีผลจริงของทุกตราสาร — "1 lot" แต่ละตัวคนละขนาด ต้องดูแยก
            max_lot_by_instrument: Object.fromEntries(INSTRUMENT_KEYS.map((k) => [k, this.maxLotFor(INSTRUMENTS[k])])),
            loss_cooldown_bars: parseInt(this.cfg('GOLD_LOSS_COOLDOWN_BARS', '3'), 10),
            sizing: this.cfg('GOLD_SIZING', 'risk'),
            // AI assist — ตัวช่วยหาจุดเข้า (เปิด/ปิดได้จากหน้า start loop)
            ai_assist: this.aiAssistEnabled(),
            ai_mode: this.aiMode(), // off | assist | lead | ai_only (effective: off when the key is missing)
            ai_mode_selected: (AI_MODES as readonly string[]).includes(this.cfg('GOLD_AI_MODE', '').toLowerCase())
                ? this.cfg('GOLD_AI_MODE', '').toLowerCase()
                : this.aiMode(),
            ai_provider: this.aiProvider(),
            ai_strictness: this.aiStrictness(),
            ai_strictness_min_confidence: STRICTNESS_MIN_AI_CONFIDENCE[this.aiStrictness()],
            claude: {
                model: this.goldAiService?.model,
                effort: this.goldAiService?.effort,
                has_key: this.goldAiService?.hasKey ?? false,
            },
            engine: this.engine(),
            risk_profile: this.riskProfileState(),
            ai_gate: this.aiGate(), // near_miss | always | setup_only
            ai_max_calls_per_day: parseInt(this.cfg('GOLD_AI_MAX_CALLS_PER_DAY', '10'), 10),
            ai_calls: this.goldGeminiService.usage(parseInt(this.cfg('GOLD_AI_MAX_CALLS_PER_DAY', '10'), 10)),
            ai: this.goldGeminiService.config,
            instrument: this.instrumentInfo(),
            overridden: [...this.overrides.keys()],
        };
    }

    /**
     * ตั้งค่าจาก dashboard — จำลงไฟล์ (GOLD_SETTINGS_FILE) คงอยู่ข้ามการรีสตาร์ท
     *
     * ทั้งหมดหรือไม่มีเลย: ตรวจทุกฟิลด์ลง `staged` ก่อน ถ้าฟิลด์ไหนผิดจะโยน DomainError
     * โดยยังไม่แตะค่าที่ใช้อยู่เลย (เดิมฟิลด์ที่ผ่านก่อนหน้าค้างอยู่ใน memory แต่ไม่ถูกบันทึก)
     * ผ่านครบแล้วจึง apply + persist ในขั้นเดียว
     */
    setSettings(body: Record<string, any>, opts: { riskProfile?: RiskProfileMarker } = {}) {
        demoContext.assertNotDemo('Changing settings');
        const map: Record<string, { key: string; min: number; max: number }> = {
            risk_usd_per_trade: { key: 'GOLD_RISK_USD_PER_TRADE', min: 1, max: 100_000 },
            daily_max_loss_usd: { key: 'GOLD_DAILY_MAX_LOSS_USD', min: 0, max: 1_000_000 },
            max_open_positions: { key: 'GOLD_MAX_OPEN_POSITIONS', min: 1, max: 20 },
            // เพดานรวมทุกตราสารเวลาเปิดหลายตัวพร้อมกัน · 0 = ไม่จำกัด (ใช้แค่เพดานต่อตราสารข้างบน)
            max_open_positions_total: { key: 'GOLD_MAX_OPEN_POSITIONS_TOTAL', min: 0, max: 200 },
            scalp_max_per_day: { key: 'GOLD_SCALP_MAX_PER_DAY', min: 1, max: 50 },
            // เพดานที่ TA สร้างได้จริง = 8 (confBase สูงสุด 7 + โบนัสตัวประกอบ 1)
            // ตั้งเกินนี้ = ไม่มีไม้ไหนผ่านเลย บอทเงียบสนิทโดยไม่มีอะไรฟ้อง
            min_confidence: { key: 'GOLD_MIN_CONFIDENCE', min: 0, max: TA_MAX_CONFIDENCE },
            // จำนวนครั้งที่ยอมให้เรียก AI ต่อวัน · 0 = ไม่จำกัด · ชนเพดานแล้วสลับ TA ล้วนอัตโนมัติ
            ai_max_calls_per_day: { key: 'GOLD_AI_MAX_CALLS_PER_DAY', min: 0, max: 10_000 },
            max_lot: { key: 'GOLD_MAX_LOT', min: 0.01, max: 100 },
            max_lot_xauusd: { key: 'GOLD_MAX_LOT_XAUUSD', min: 0.01, max: 100 },
            max_lot_eurusd: { key: 'GOLD_MAX_LOT_EURUSD', min: 0.01, max: 100 },
            max_lot_gbpusd: { key: 'GOLD_MAX_LOT_GBPUSD', min: 0.01, max: 100 },
            max_lot_usdjpy: { key: 'GOLD_MAX_LOT_USDJPY', min: 0.01, max: 100 },
            loss_cooldown_bars: { key: 'GOLD_LOSS_COOLDOWN_BARS', min: 0, max: 100 },
        };
        const given = (v: unknown) => v !== undefined && v !== null && v !== '';
        // ---- 1) validate only: nothing below may touch live state until every field has passed ----
        const staged = new Map<string, string>(); // override key → value (later fields win, e.g. ai_mode over ai_assist)
        const geminiRuntime = new Map<string, string>(); // values that must also be forwarded to goldGeminiService
        const claudeRuntime = new Map<string, string>(); // same for goldAiService (Claude engine)
        const logs: string[] = [];
        const applied: string[] = [];
        let leadOn = false;
        let modeChanged = false;

        // ai_assist เป็นสวิตช์ ไม่ใช่ตัวเลข — รับก่อนแล้วค่อยวนค่าที่เหลือ
        if (given(body.ai_assist)) {
            const on = body.ai_assist === true || String(body.ai_assist).toLowerCase() === 'true';
            if (on && !this.goldGeminiService.apiKey) {
                throw new DomainError('Cannot enable AI assist: GEMINI_API_KEY is not set in env');
            }
            staged.set('GOLD_AI_ASSIST', on ? 'true' : 'false');
            staged.set('GOLD_AI_MODE', on ? 'assist' : 'off');
            applied.push('ai_assist');
            logs.push(`AI assist ${on ? 'enabled' : 'disabled'} from dashboard`);
        }

        // ai_gate: รอบไหนควรถาม AI (ดู aiGate() ว่าแต่ละค่าหมายถึงอะไร)
        if (given(body.ai_gate)) {
            const g = String(body.ai_gate).toLowerCase();
            if (!['near_miss', 'always', 'setup_only'].includes(g)) {
                throw new DomainError('ai_gate must be near_miss | always | setup_only');
            }
            staged.set('GOLD_AI_GATE', g);
            applied.push(`ai_gate=${g}`);
            logs.push(`AI gate → ${g} from dashboard`);
        }

        // ระดับการคิดของ Gemini — ค่าตาม doc: minimal | low | medium | high (3.x รองรับครบ)
        // ต้องยิงเข้า goldGeminiService ด้วย เพราะ service นั้นอ่าน ConfigService คนละก้อนกับ overrides ที่นี่
        if (given(body.ai_thinking)) {
            const lv = String(body.ai_thinking).toLowerCase().trim();
            if (!['minimal', 'low', 'medium', 'high'].includes(lv)) {
                throw new DomainError('ai_thinking must be minimal | low | medium | high');
            }
            staged.set('GOLD_AI_THINKING', lv);
            geminiRuntime.set('GOLD_AI_THINKING', lv);
            claudeRuntime.set('GOLD_AI_THINKING', lv);
            applied.push(`ai_thinking=${lv}`);
            logs.push(`AI thinking level → ${lv} from dashboard`);
        }

        // รุ่น Gemini — รับเฉพาะชื่อที่ขึ้นต้น gemini- และเป็น 3.x ขึ้นไป (thinking_level รองรับครบ)
        if (given(body.ai_model)) {
            const m = String(body.ai_model).trim();
            if (/^claude-[a-z0-9.-]+$/i.test(m)) {
                if (!(this.goldAiService?.hasKey ?? false)) {
                    throw new DomainError('Cannot use a Claude model: ANTHROPIC_API_KEY is not set');
                }
                const mode = given(body.ai_mode) ? String(body.ai_mode).toLowerCase() : this.cfg('GOLD_AI_MODE', '');
                if (mode === 'assist' || mode === 'lead') {
                    throw new DomainError(
                        `Claude models work in AI-only mode only — the current AI mode is ${mode} (Gemini only)`,
                    );
                }
                staged.set('GOLD_AI_PROVIDER', 'claude');
                staged.set('GOLD_CLAUDE_MODEL', m);
                claudeRuntime.set('GOLD_CLAUDE_MODEL', m);
                applied.push(`ai_model=${m}`);
                logs.push(`Claude model → ${m} from the dashboard`);
            } else {
                const ver = parseFloat(m.replace(/^gemini-/, ''));
                if (!/^gemini-[a-z0-9.-]+$/i.test(m) || !Number.isFinite(ver) || ver < 3) {
                    throw new DomainError(
                        'ai_model must be a Gemini 3.x+ model (e.g. gemini-3.5-flash) or a Claude model (claude-...)',
                    );
                }
                staged.set('GOLD_AI_PROVIDER', 'gemini');
                staged.set('GEMINI_MODEL', m);
                geminiRuntime.set('GEMINI_MODEL', m);
                applied.push(`ai_model=${m}`);
                logs.push(`Gemini model → ${m} from the dashboard`);
            }
        }

        // ai_strictness: only ever tightens (see ai-strictness.ts)
        if (given(body.ai_strictness)) {
            const lv = String(body.ai_strictness).toLowerCase().trim();
            if (!(AI_STRICTNESS_LEVELS as readonly string[]).includes(lv)) {
                throw new DomainError(`ai_strictness must be ${AI_STRICTNESS_LEVELS.join(' | ')}`);
            }
            staged.set('GOLD_AI_STRICTNESS', lv);
            geminiRuntime.set('GOLD_AI_STRICTNESS', lv);
            claudeRuntime.set('GOLD_AI_STRICTNESS', lv);
            applied.push(`ai_strictness=${lv}`);
            logs.push(`AI strictness → ${lv} from the dashboard`);
        }

        // ai_mode: off | assist | lead — สวิตช์ละเอียดกว่า ai_assist (ถ้าส่งมาจะทับ)
        if (given(body.ai_mode)) {
            const m = String(body.ai_mode).toLowerCase();
            if (!(AI_MODES as readonly string[]).includes(m)) {
                throw new DomainError('ai_mode must be off | assist | lead | ai_only');
            }
            // the provider this request ends with: a model in the same body wins over the stored one
            const provider: AiProvider = given(body.ai_model)
                ? /^claude-/i.test(String(body.ai_model).trim())
                    ? 'claude'
                    : 'gemini'
                : this.aiProvider();
            if ((m === 'assist' || m === 'lead') && provider === 'claude') {
                throw new DomainError(
                    `AI mode ${m} works with Gemini models only — pick a Gemini model, or use ai_only for Claude`,
                );
            }
            if (m !== 'off' && provider === 'claude' && !(this.goldAiService?.hasKey ?? false)) {
                throw new DomainError(`Cannot enable AI mode ${m}: ANTHROPIC_API_KEY is not set`);
            }
            if (m !== 'off' && provider === 'gemini' && !this.goldGeminiService.apiKey) {
                throw new DomainError(`Cannot enable AI mode ${m}: GEMINI_API_KEY is not set`);
            }
            staged.set('GOLD_AI_MODE', m);
            staged.set('GOLD_AI_ASSIST', m === 'off' ? 'false' : 'true');
            modeChanged = true;
            leadOn = m === 'lead';
            applied.push(`ai_mode=${m}`);
            logs.push(`AI mode → ${m} from dashboard`);
        }

        for (const [field, spec] of Object.entries(map)) {
            if (!given(body[field])) continue;
            const v = Number(body[field]);
            if (!isFinite(v) || v < spec.min || v > spec.max) {
                throw new DomainError(`${field} must be a number ${spec.min}–${spec.max}`);
            }
            staged.set(spec.key, String(v));
            applied.push(`${field}=${v}`);
        }

        // ---- 2) every field passed: apply and persist in one step ----
        if (opts.riskProfile) {
            staged.set('GOLD_RISK_PROFILE', JSON.stringify(opts.riskProfile));
            applied.push(`risk_profile=${opts.riskProfile.name}`);
        }
        if (applied.length) {
            for (const [k, v] of staged) this.overrides.set(k, v);
            for (const [k, v] of geminiRuntime) this.goldGeminiService.setRuntime(k, v);
            for (const [k, v] of claudeRuntime) this.goldAiService?.setRuntime?.(k, v);
            if (modeChanged) this.assistKeyWarned = false;
            for (const line of logs) this.logger.log(line);
            if (leadOn) {
                this.activity.push(
                    'warn',
                    '🤖 AI lead mode enabled — when TA finds no setup the AI looks for a trade itself (size capped at half, all risk guards still apply)',
                );
            }
            // จำลงไฟล์ทันที ไม่งั้นค่าที่เพิ่งตั้งหายตอนรีสตาร์ทแล้วเด้งกลับไปค่า .env ที่หลวมกว่า
            this.persistOverrides();
            this.activity.push('warn', `Risk settings updated from dashboard: ${applied.join(' · ')}`);
        }
        return this.getSettings();
    }

    /* ════════════════════════════════════════════════════════════════
     * 🎛️  ประตูตัดสินว่า "รอบนี้ถาม AI ไหม" — GOLD_AI_GATE
     * ════════════════════════════════════════════════════════════════
     *   near_miss   (ค่าตั้งต้น) ถามเมื่อ TA เจอ setup + เมื่อ NO_TRADE แบบ "เฉียด"
     *                            ~29 ครั้ง/วัน · ตัดรอบที่ไม่มี setup เลยออก 53%
     *   always                   ถามทุกรอบที่ TA วิเคราะห์จบ (~68 ครั้ง/วัน) เปลืองสุด
     *   setup_only               ถามเฉพาะตอน TA เจอ setup (~5 ครั้ง/วัน) ประหยัดสุด
     *                            = พฤติกรรมของโหมด assist ล้วน
     *
     * เปลี่ยนได้จาก env หรือ dashboard ทันที ไม่ต้องรีสตาร์ท ไม่ต้องแก้โค้ด
     * (ตัวกำหนดว่าอะไรคือ "เฉียด" อยู่ที่ NEAR_MISS_RULES ใน gold-ta.service.ts)
     * ════════════════════════════════════════════════════════════════
     */
    aiGate(): 'near_miss' | 'always' | 'setup_only' {
        const g = this.cfg('GOLD_AI_GATE', 'near_miss').toLowerCase();
        return g === 'always' || g === 'setup_only' ? g : 'near_miss';
    }

    /** รอบนี้ควรให้ AI หาไม้เองไหม (ใช้เฉพาะตอน TA ตอบ NO_TRADE ในโหมด lead) */
    private shouldAskAiForSetup(d: GoldDecision): { ask: boolean; why: string } {
        const gate = this.aiGate();
        if (gate === 'setup_only')
            return { ask: false, why: 'gate=setup_only — ask the AI only when TA finds a setup' };
        if (gate === 'always') return { ask: true, why: 'gate=always' };
        return d.near_miss
            ? { ask: true, why: `near miss (${d.near_miss_rule})` }
            : { ask: false, why: 'no setup at all — asking would just waste quota' };
    }

    /**
     * Models the dashboard can pick, from every provider with a key. `modes` says where each one works:
     * Gemini serves assist/lead/ai_only, Claude serves ai_only only. `current` is the model in use for
     * the selected provider (kept as a string for older clients); `gemini_current` / `claude_current` per provider.
     */
    async listAiModels() {
        const gemini_current = this.goldGeminiService.config.model;
        const claude_current = this.goldAiService?.model;
        const errors: string[] = [];
        const [gem, cla] = await Promise.all([
            this.goldGeminiService.listModels().catch((e) => {
                errors.push(`Gemini: ${errorMessage(e)}`);
                return [] as Array<{ id: string; label: string; out?: number }>;
            }),
            this.goldAiService.listModels().catch((e) => {
                errors.push(`Claude: ${errorMessage(e)}`);
                return [] as Array<{ id: string; label: string }>;
            }),
        ]);
        if (errors.length) this.logger.warn(`Could not list AI models: ${errors.join(' · ')}`);
        const models = [
            ...gem.map((m) => ({ ...m, provider: 'gemini' as const, modes: ['assist', 'lead', 'ai_only'] })),
            ...cla.map((m) => ({ ...m, provider: 'claude' as const, modes: ['ai_only'] })),
        ];
        return {
            current: this.aiProvider() === 'claude' ? claude_current : gemini_current,
            provider: this.aiProvider(),
            gemini_current,
            claude_current,
            has_gemini_key: !!this.goldGeminiService.apiKey,
            has_claude_key: this.goldAiService?.hasKey ?? false,
            models,
            ...(errors.length ? { error: errors.join(' · ') } : {}),
        };
    }

    /** every setting that decides how a round trades, for the round's archive record and its order */
    configSnapshot(p: InstrumentProfile, mode: GoldMode, rrMin: number): ConfigSnapshot {
        const n = this.getSettingsNumbers();
        const gemini = this.goldGeminiService.config;
        const provider = this.aiProvider();
        const selected = this.cfg('GOLD_AI_MODE', '').toLowerCase();
        return {
            app: appVersion(),
            account_mode: this.configService.get<string>('CTRADER_ACCOUNT_MODE', 'DEMO').toUpperCase(),
            instrument: {
                key: p.key,
                symbol_id: this.instruments.cachedSymbolId(p),
                digits: p.digits,
                pip: p.pip,
                units_per_lot: p.unitsPerLot,
            },
            mode: {
                name: mode,
                rr_min: rrMin,
                period_min: MODE_CFG[mode].periodMin,
                tradable_modes: this.tradableModesFor(p),
            },
            engine: this.engine(),
            data_source: this.configService.get<string>('GOLD_DATA_SOURCE', 'local').toLowerCase(),
            risk_profile: this.riskProfileState(),
            risk: {
                sizing: this.cfg('GOLD_SIZING', 'risk').toLowerCase(),
                risk_usd_per_trade: n.risk_usd_per_trade,
                base_lot: parseFloat(this.cfg('GOLD_BASE_LOT', '0.1')),
                daily_max_loss_usd: n.daily_max_loss_usd,
                max_open_positions: n.max_open_positions,
                max_open_positions_total: n.max_open_positions_total,
                min_confidence: n.min_confidence,
                loss_cooldown_bars: n.loss_cooldown_bars,
                scalp_max_per_day: n.scalp_max_per_day,
                max_lot: this.maxLotFor(p),
                risk_tolerance: parseFloat(this.cfg('GOLD_RISK_TOLERANCE', '1.2')),
            },
            ai: {
                mode_selected: selected || this.aiMode(),
                mode_effective: this.aiMode(),
                provider,
                model: provider === 'claude' ? this.goldAiService.model : gemini.model,
                thinking: gemini.thinking_level,
                strictness: this.aiStrictness(),
                strictness_min_confidence: STRICTNESS_MIN_AI_CONFIDENCE[this.aiStrictness()],
                gate: this.aiGate(),
                temperature: gemini.temperature,
                max_calls_per_day: parseInt(this.cfg('GOLD_AI_MAX_CALLS_PER_DAY', '10'), 10),
            },
            overrides: withoutSecrets(this.overrides),
        };
    }

    /** live bid/ask of the instrument at this moment (null without a tick) */
    private tickSnapshot(p: InstrumentProfile): RoundTrace['market'] {
        const tk = this.getLastTick(p);
        if (!tk) return null;
        return {
            bid: tk.bid,
            ask: tk.ask,
            spread: Number((tk.ask - tk.bid).toFixed(p.digits)),
            tick_age_ms: Date.now() - tk.at,
        };
    }

    /** the last applied risk profile and whether a setting was changed by hand since */
    riskProfileState(): { id: string; name: string; modified: boolean; changed: string[] } | null {
        const raw = this.overrides.get('GOLD_RISK_PROFILE');
        if (!raw) return null;
        try {
            const m = JSON.parse(raw) as RiskProfileMarker;
            const now = this.getSettingsNumbers();
            const changed = Object.entries(m.applied)
                .filter(([k, v]) => k in now && Number(now[k]) !== Number(v))
                .map(([k]) => k);
            return { id: m.id, name: m.name, modified: changed.length > 0, changed };
        } catch {
            return null;
        }
    }

    /** the numeric risk settings keyed like the setSettings body (used to compare against a profile) */
    private getSettingsNumbers(): Record<string, number> {
        const lot = (k: InstrumentKey) => this.maxLotFor(INSTRUMENTS[k]);
        return {
            risk_usd_per_trade: parseFloat(this.cfg('GOLD_RISK_USD_PER_TRADE', '1500')),
            daily_max_loss_usd: parseFloat(this.cfg('GOLD_DAILY_MAX_LOSS_USD', '4000')),
            max_open_positions: parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS', '20'), 10),
            max_open_positions_total: parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS_TOTAL', '0'), 10),
            scalp_max_per_day: parseInt(this.cfg('GOLD_SCALP_MAX_PER_DAY', '40'), 10),
            min_confidence: parseInt(this.cfg('GOLD_MIN_CONFIDENCE', '7'), 10),
            loss_cooldown_bars: parseInt(this.cfg('GOLD_LOSS_COOLDOWN_BARS', '3'), 10),
            max_lot_xauusd: lot('XAUUSD'),
            max_lot_eurusd: lot('EURUSD'),
            max_lot_gbpusd: lot('GBPUSD'),
            max_lot_usdjpy: lot('USDJPY'),
        };
    }

    /** ปุ่มรีเซ็ตโควตา AI บน dashboard — เริ่มนับใหม่ทันที ไม่ต้องรอข้ามวัน */
    resetAiCalls() {
        demoContext.assertNotDemo('Resetting the AI quota');
        const max = parseInt(this.cfg('GOLD_AI_MAX_CALLS_PER_DAY', '10'), 10);
        const before = this.goldGeminiService.resetUsage();
        this.aiQuotaWarnedDay.clear();
        this.activity.push('ok', `🔄 AI quota reset (previously used ${before}/${max} calls) — AI is available again`);
        return { reset_from: before, ...this.goldGeminiService.usage(max) };
    }

    /** จุด reset ของ "วันนี้" เท่านั้น — ข้ามวัน UTC แล้วถือว่าหมดอายุ */
    private activeDailyStopReset(): { day: string; ts: number } | null {
        if (!this.dailyStopReset) return null;
        const today = new Date().toISOString().slice(0, 10);
        if (this.dailyStopReset.day !== today) {
            this.dailyStopReset = null;
            return null;
        }
        return this.dailyStopReset;
    }

    /**
     * ปุ่ม "เคลียร์ daily stop" บน dashboard — ปลดด่านกันขาดทุนรายวันด้วยมือ
     *
     * ไม่ได้ปิดด่านทิ้ง แต่ขยับจุดเริ่มนับมาที่ "ตอนนี้" — ขาดทุนที่เกิดหลังจากนี้ยังนับ
     * และตัดการเทรดซ้ำได้อีกถ้าถึงเพดาน · หมดอายุเองเมื่อข้ามวัน UTC
     *
     * เป็นการปลดด่านความปลอดภัยด้วยมือ จึงบันทึกเสียงดังทั้ง log และ activity
     */
    resetDailyStop() {
        demoContext.assertNotDemo('Clearing the daily stop');
        const before = this.pnlCache?.value ?? null;
        const limit = parseFloat(this.cfg('GOLD_DAILY_MAX_LOSS_USD', '4000'));
        const now = new Date();
        this.dailyStopReset = { day: now.toISOString().slice(0, 10), ts: now.getTime() };
        this.pnlCache = null; // force a fresh broker query instead of the value cached before the click
        this.deals.invalidate();
        const beforeTxt = before == null ? 'never read' : `${before.toFixed(2)} USD`;
        this.logger.warn(
            `Daily stop cleared manually (P&L before clearing ${beforeTxt} · limit -${limit}) — counting restarts now`,
        );
        this.activity.push(
            'warn',
            `⚠️ Daily stop cleared manually (loss before clearing ${beforeTxt}) — counting restarts from now ` +
                `· the guard stays active and will stop again if new losses reach -${limit}`,
        );
        return {
            reset_at: now.toISOString(),
            pnl_before: before,
            daily_max_loss_usd: limit,
        };
    }

    /**
     * runtime start/stop from the dashboard — overrides env until restart
     * @param instruments ตราสารที่ loop จะวนเทรด — ไม่ส่งมา/ว่าง = คงค่าเดิม (default = ตัว active เดียว)
     */
    setAutomate(enabled: boolean, modes?: GoldMode[], instruments?: string[]) {
        demoContext.assertNotDemo('Starting or stopping the loop');
        this.runtimeEnabled = enabled;
        if (modes?.length) this.runtimeModes = modes;
        // เช็ค .length เหมือน modes ข้างบน — [] ต้องแปลว่า "ไม่ได้ส่งมาจริง ๆ คงค่าเดิม"
        // ไม่ใช่ "รีเซ็ตกลับเป็นตัว active เดียว" (array ว่างเป็น truthy ใน JS เช็คแค่ if(instruments) ไม่พอ)
        if (instruments?.length) {
            const keys = instruments.map((k) => String(k).trim().toUpperCase()).filter((k) => isInstrumentKey(k));
            if (keys.length) this.runtimeInstruments = keys.join(',');
        }
        this.logger.log(
            `automate ${enabled ? 'STARTED' : 'STOPPED'} ` +
                `(modes: ${this.enabledModes().join(', ')} · instruments: ${this.enabledInstruments()
                    .map((p) => p.key)
                    .join(', ')})`,
        );
        return this.getStatus();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
        if (this.beTimer) clearInterval(this.beTimer);
    }

    /**
     * move SL to breakeven (+0.1R lock) once an open GOLD_AI position reaches +1R
     * ดูแลทุกตราสารที่บอทเคยเปิด (ไม่ใช่แค่ตัวที่เลือกอยู่) — สลับตราสารแล้วไม้เก่ายังมีคนดูแล
     */
    private async manageOpenPositions() {
        if (!this.ctraderService.isAuthorized) return;
        const num = (v: any) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));
        const rec = await this.ctraderService.getPositions();
        const all = (rec?.position ?? []) as any[];
        if (!all.length) return;

        const orders = await this.ordersService.findByPositionIds(all.map((p) => num(p.positionId)));
        const orderByPos = new Map<number, any>();
        for (const o of orders as any[])
            if (o.positionId && o.strategy === 'GOLD_AI') orderByPos.set(Number(o.positionId), o);
        if (!orderByPos.size) return;

        // latest price per symbol from the newest M1 bar (cheap, no subscription needed)
        const pxCache = new Map<number, number | null>();
        const lastPrice = async (symbolId: number): Promise<number | null> => {
            if (pxCache.has(symbolId)) return pxCache.get(symbolId)!;
            let px: number | null = null;
            try {
                const tb = await this.ctraderService.request<any>(
                    'ProtoOAGetTrendbarsReq',
                    {
                        ctidTraderAccountId: this.ctraderService.activeAccountId,
                        fromTimestamp: Date.now() - 30 * 60_000,
                        toTimestamp: Date.now(),
                        period: 1,
                        symbolId,
                        count: 2,
                    },
                    15_000,
                );
                const bars = (tb?.trendbar ?? []) as any[];
                if (bars.length) {
                    const lastBar = bars[bars.length - 1];
                    px = (num(lastBar.low) + num(lastBar.deltaClose)) / 100_000;
                }
            } catch (e) {
                this.logger.warn(`[BE/TRAIL] M1 price for symbol ${symbolId} failed: ${errorMessage(e)}`);
            }
            pxCache.set(symbolId, px);
            return px;
        };

        for (const pos of all) {
            const pid = num(pos.positionId);
            const o = orderByPos.get(pid);
            if (!o) continue;
            const symbolId = num(pos.tradeData?.symbolId);
            const prof = this.instruments.profileBySymbolId(symbolId);
            if (!prof) continue; // position of an unknown symbol — leave it alone
            const px = await lastPrice(symbolId);
            if (px == null) continue;
            const entry = num(pos.price) || o.price;
            const sl = o.stopLoss;
            if (!entry || !sl) continue;
            const dir = num(pos.tradeData?.tradeSide) === 1 ? 1 : -1;
            const risk = dir * (entry - sl);
            if (risk <= 0) continue;
            const progress = (dir * (px - entry)) / risk;
            const stt = this.posMgr.get(pid) ?? { be: false, lastSl: sl };
            const tag = prof.key;

            try {
                // step 1: +1R -> lock breakeven (+0.1R)
                if (progress >= 1 && !stt.be) {
                    const newSl = roundPrice(prof, entry + dir * 0.1 * risk);
                    await this.ctraderService.amendPositionSLTP(pid, newSl, o.takeProfit ?? undefined);
                    stt.be = true;
                    stt.lastSl = newSl;
                    this.logger.log(`[${tag} BE] position ${pid} reached +1R (px ${px}) — SL moved ${sl} -> ${newSl}`);
                    await this.telegramService.notifyOrderSuccess(
                        `🔒 [${tag}] reached +1R, SL moved to breakeven\nposition ${pid}: SL ${sl} → ${newSl} (entry ${entry})`,
                    );
                }
                // step 2: +1.5R ขึ้นไป -> trail 0.75R หลังราคา (ขยับเมื่อดีขึ้น >= 0.25R)
                if (progress >= 1.5 && stt.be) {
                    const trail = roundPrice(prof, px - dir * 0.75 * risk);
                    if (dir * (trail - stt.lastSl) >= 0.25 * risk) {
                        await this.ctraderService.amendPositionSLTP(pid, trail, o.takeProfit ?? undefined);
                        stt.lastSl = trail;
                        this.logger.log(
                            `[${tag} TRAIL] position ${pid} at +${progress.toFixed(2)}R — SL trailed to ${trail}`,
                        );
                    }
                }
            } catch (e) {
                this.logger.error(`[${tag} BE/TRAIL] amend failed for ${pid}: ${errorMessage(e)}`);
            }
            this.posMgr.set(pid, stt);
        }
    }

    isEnabled(): boolean {
        if (this.runtimeEnabled !== null) return this.runtimeEnabled;
        return this.configService.get<string>('GOLD_AUTOMATE_ENABLED', 'false').toLowerCase() === 'true';
    }

    enabledModes(): GoldMode[] {
        if (this.runtimeModes?.length) return this.runtimeModes;
        return this.configService
            .get<string>('GOLD_MODES', 'swing')
            .split(',')
            .map((m) => m.trim().toLowerCase())
            .filter((m): m is GoldMode => m in MODE_CFG);
    }

    /**
     * โหมดที่ "ตราสารนี้" เทรดได้จริง = โหมดที่เปิดไว้ ∩ โหมดที่ตราสารรองรับ
     *
     * ทองถูกจำกัดไว้ที่ scalp/intraday เพราะไม้ต่ำสุด 0.01 lot ของทองเสี่ยง ~$1/จุด
     * พอ SL กว้างแบบ swing (~35 จุด) ไม้ต่ำสุดก็เสี่ยง ~$35 แล้ว ลดกว่านี้ไม่ได้
     * = ตั้งงบเสี่ยงต่อไม้เท่าไหร่ก็ไม่มีผล (ดู InstrumentProfile.tradableModes)
     * แก้ได้ที่ env GOLD_MODES_<KEY> ถ้าจะยอมรับความเสี่ยงนั้น
     */
    tradableModesFor(p: InstrumentProfile): GoldMode[] {
        const raw = this.cfg(`GOLD_MODES_${p.key}`, '');
        const allowed = raw
            ? raw
                  .split(',')
                  .map((m) => m.trim().toLowerCase())
                  .filter((m): m is GoldMode => m in MODE_CFG)
            : p.tradableModes;
        if (!allowed?.length) return this.enabledModes();
        return this.enabledModes().filter((m) => allowed.includes(m));
    }

    /** โหมดที่ตราสารนี้ "ไม่ให้เทรด" (ไว้บอกเหตุผลบน dashboard) */
    blockedModesFor(p: InstrumentProfile): GoldMode[] {
        const ok = this.tradableModesFor(p);
        return this.enabledModes().filter((m) => !ok.includes(m));
    }

    /**
     * ตราสารที่ loop วนเทรดพร้อมกัน — ไม่ตั้งอะไรเลย = ใช้ตัว active เดียว (พฤติกรรมเดิม
     * ก่อนมีหลายตราสาร) ตั้งได้จาก dashboard/env ให้เลือกกี่ตัวก็ได้ หรือครบทั้ง 4 ตัวเลย
     * (XAUUSD/EURUSD/GBPUSD/USDJPY) — คนละเรื่องกับ instruments.setActive() ที่เป็น
     * "ตราสารที่เลือกดูบนหน้าเว็บ/สั่งรันเอง" ตัวนี้คือ "ตราสารที่ loop อัตโนมัติจะวนเทรด"
     */
    enabledInstruments(): InstrumentProfile[] {
        const raw = this.runtimeInstruments ?? this.configService.get<string>('GOLD_INSTRUMENTS', '');
        if (!raw) return [this.profile];
        const keys = raw
            .split(',')
            .map((k) => k.trim().toUpperCase())
            .filter((k) => isInstrumentKey(k));
        return keys.length ? keys.map((k) => INSTRUMENTS[k]) : [this.profile];
    }

    getStatus() {
        const prof = this.profile;
        const prefix = `${prof.key}:`;
        const out: Record<string, ModeState> = {};
        for (const [key, s] of this.state) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = s;
        const pending: Record<string, any> = {};
        for (const [key, p] of this.pending) {
            if (!key.startsWith(prefix)) continue;
            pending[key.slice(prefix.length)] = {
                id: p.id,
                age_sec: Math.round((Date.now() - p.createdAt) / 1000),
                ttl_sec: Math.max(0, Math.round((PENDING_TTL_MS - (Date.now() - p.createdAt)) / 1000)),
                order: `${p.decision.order_type} @ ${p.decision.entry} SL ${p.decision.sl} TP1 ${p.decision.tp1} (RR ${p.decision.rr_tp1})`,
            };
        }
        return {
            enabled: this.isEnabled(),
            modes: this.enabledModes(),
            // ตราสารที่ loop วนเทรดพร้อมกัน (คนละเรื่องกับ `instrument` = ตัวที่หน้าเว็บกำลังดูอยู่)
            enabled_instruments: this.enabledInstruments().map((p) => p.key),
            // โหมดที่แต่ละตราสารเทรดได้/ถูกปิด — dashboard เอาไปขึ้นคำเตือน
            tradable_modes: Object.fromEntries(INSTRUMENT_KEYS.map((k) => [k, this.tradableModesFor(INSTRUMENTS[k])])),
            blocked_modes: Object.fromEntries(INSTRUMENT_KEYS.map((k) => [k, this.blockedModesFor(INSTRUMENTS[k])])),
            max_open_positions_total: parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS_TOTAL', '0'), 10),
            accountMode: this.configService.get<string>('CTRADER_ACCOUNT_MODE', 'DEMO').toUpperCase(),
            engine: this.engine(),
            ai_assist: this.aiAssistEnabled(),
            instrument: this.instrumentInfo(prof),
            ctraderAuthorized: this.ctraderService.isAuthorized,
            // ตลาดของตราสารที่หน้าเว็บกำลังดูอยู่ (เข้ากันได้กับ dashboard เดิม)
            market: marketStatus(new Date(), prof.hours),
            // ตลาดของทุกตราสารที่ loop เปิดจริง — โลหะ/FX ตลาดปิดเปิดคนละเวลา ห้ามใช้ market ตัวเดียวแทนทั้งหมด
            markets: Object.fromEntries(
                this.enabledInstruments().map((p) => [p.key, marketStatus(new Date(), p.hours)]),
            ),
            price: this.getLastTick(prof)
                ? {
                      bid: this.getLastTick(prof)!.bid,
                      ask: this.getLastTick(prof)!.ask,
                      age_sec: Math.round((Date.now() - this.getLastTick(prof)!.at) / 1000),
                  }
                : null,
            // ราคาสดของทุกตราสารที่ loop เปิดจริง (สำหรับ badge หัวหน้าเว็บตอนเทรดหลายตราสารพร้อมกัน)
            prices: Object.fromEntries(
                this.enabledInstruments().map((p) => {
                    const t = this.getLastTick(p);
                    return [
                        p.key,
                        t ? { bid: t.bid, ask: t.ask, age_sec: Math.round((Date.now() - t.at) / 1000) } : null,
                    ];
                }),
            ),
            pending,
            state: out,
        };
    }

    private getState(mode: GoldMode, p: InstrumentProfile = this.profile): ModeState {
        const key = this.sk(mode, p);
        let s = this.state.get(key);
        if (!s) {
            s = { lastRunAt: null, lastBarBucket: -1, lastDecision: null, lastOutcome: null, lastError: null };
            this.state.set(key, s);
        }
        return s;
    }

    // ---------- scheduler ----------

    private async tick() {
        // รู้จัก symbolId ของทุกตราสารไว้ก่อน — ไม่งั้นไม้ของตราสารที่ไม่ได้ active
        // จะกลายเป็นไม้กำพร้าหลังรีสตาร์ท (ไม่มี BE/trailing + หายจากหน้า positions)
        if (this.ctraderService.isAuthorized) {
            await this.instruments.resolveAll().catch((e) => this.logger.warn(`resolveAll: ${errorMessage(e)}`));
        }
        await this.ensureSpotSubscription();
        const now = new Date();

        if (!this.isEnabled()) {
            this.heartbeat(now, null);
            return;
        }

        // วนทุกตราสารที่เปิดใช้งาน (ค่าเริ่มต้น = ตัว active ตัวเดียว เหมือนพฤติกรรมเดิม
        // ก่อนรองรับหลายตราสาร) — แต่ละตราสารมีชั่วโมงตลาด/สถานะแท่ง/guard ของตัวเอง
        // ไม่ปนกัน เพราะ state/running/pending ทุกตัวคีย์ด้วย `${instrument}:${mode}` อยู่แล้ว
        const waits: string[] = [];
        for (const prof of this.enabledInstruments()) {
            // ตลาดปิด = พักเฉพาะตราสารนี้ ตราสารอื่นเดินต่อได้ตามปกติ
            const mkt = marketStatus(now, prof.hours);
            const wasOpen = this.marketWasOpen.get(prof.key) ?? true;
            if (!mkt.open) {
                if (wasOpen) {
                    this.activity.push(
                        'warn',
                        `⏸ ${prof.emoji} ${prof.key}: ${mkt.reason} — pausing this instrument only, will resume automatically when the market opens`,
                    );
                    this.marketWasOpen.set(prof.key, false);
                }
                waits.push(`${prof.key}: market closed`);
                continue;
            }
            if (!wasOpen) {
                this.activity.push(
                    'ok',
                    `▶ ${prof.emoji} ${prof.key}: ${prof.hours.label_th} reopened (${mkt.et_time} ET) — resuming automatically`,
                );
                this.marketWasOpen.set(prof.key, true);
                // เริ่มนับแท่งใหม่เฉพาะตราสารนี้ ไม่ต้องไล่วิเคราะห์ย้อนหลังตอนเพิ่งเปิด
                for (const mode of this.tradableModesFor(prof)) {
                    const cfg = MODE_CFG[mode];
                    if (cfg.periodMin < 1440) {
                        this.getState(mode, prof).lastBarBucket = Math.floor(now.getTime() / (cfg.periodMin * 60_000));
                    }
                }
            }

            for (const mode of this.tradableModesFor(prof)) {
                const tag = this.enabledInstruments().length > 1 ? `${prof.key}/${mode}` : mode;
                if (this.running.has(this.sk(mode, prof))) {
                    waits.push(`${tag}: analyzing…`);
                    continue;
                }

                if (mode === 'position') {
                    if (this.isPositionDue(now, prof)) this.launch(mode, prof);
                    else waits.push(`${tag}: waiting for the daily run`);
                    continue;
                }

                const cfg = MODE_CFG[mode];
                const periodMs = cfg.periodMin * 60_000;
                const bucket = Math.floor(now.getTime() / periodMs);
                const sinceBarOpenMs = now.getTime() - bucket * periodMs;
                const st = this.getState(mode, prof);
                // run once per bar, shortly after it opens (= previous bar just closed)
                if (bucket > st.lastBarBucket && sinceBarOpenMs >= cfg.offsetSec * 1000) {
                    st.lastBarBucket = bucket;
                    this.activity.push(
                        'info',
                        `${cfg.periodMin}m bar closed → starting a new analysis round`,
                        `${prof.key}/${mode}`,
                    );
                    this.launch(mode, prof);
                } else {
                    const leftMs = periodMs - sinceBarOpenMs;
                    waits.push(`${tag}: in ${this.fmtWait(leftMs)}`);
                }
            }
        }
        this.heartbeat(now, waits);
    }

    private fmtWait(ms: number): string {
        const s = Math.max(0, Math.round(ms / 1000));
        return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s} s`;
    }

    /** one activity line every ~5s so the dashboard shows the bot is alive */
    private heartbeat(now: Date, waits: string[] | null, mkt?: { reason: string; minutes_to_open: number | null }) {
        if (now.getTime() - this.lastHeartbeat < 4_500) return;
        this.lastHeartbeat = now.getTime();

        // เปิดหลายตราสารพร้อมกัน = โชว์ราคาทุกตัวสั้น ๆ · เปิดตัวเดียว (ค่าเริ่มต้น) = format เดิมเป๊ะ
        const insts = this.enabledInstruments();
        const px = insts
            .map((p) => {
                const t = this.getLastTick(p);
                // โชว์อายุราคาเมื่อค้าง เพื่อให้เห็นทันทีว่าเลขที่นิ่งอยู่คือราคาเก่า ไม่ใช่ตลาดไม่ขยับ
                const age = t ? now.getTime() - t.at : 0;
                const stale = t && age > STALE_TICK_MS ? ` ⚠ stale ${Math.round(age / 60_000)} min` : '';
                return t
                    ? `${p.key} ${fmtPrice(p, t.bid)}/${fmtPrice(p, t.ask)} (spread ${fmtPrice(p, t.ask - t.bid)})${stale}`
                    : `${p.key}: waiting for live price`;
            })
            .join(' | ');
        const et = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
        }).format(now);

        if (mkt) {
            const left =
                mkt.minutes_to_open != null
                    ? ` (in ${Math.floor(mkt.minutes_to_open / 60)}:${String(mkt.minutes_to_open % 60).padStart(2, '0')} h)`
                    : '';
            this.activity.push('info', `${px} · ${et} ET · ⏸ ${mkt.reason}${left}`);
            return;
        }
        if (!waits) {
            this.activity.push('info', `${px} · ${et} ET · loop is off (press Start to let the bot trade)`);
            return;
        }
        this.activity.push('info', `${px} · ${et} ET · ${waits.join(' | ')}`);
    }

    private isPositionDue(now: Date, p: InstrumentProfile = this.profile): boolean {
        const hours = this.configService
            .get<string>('GOLD_POSITION_RUN_UTC_HOURS', '22')
            .split(',')
            .map((h) => parseInt(h.trim(), 10))
            .filter((h) => !isNaN(h));
        const key = `${now.toISOString().slice(0, 10)}T${now.getUTCHours()}`;
        if (!hours.includes(now.getUTCHours())) return false;
        if (now.getUTCMinutes() < 10) return false; // after daily bar settles
        if (this.lastPositionRunDate.get(p.key) === key) return false;
        this.lastPositionRunDate.set(p.key, key);
        return true;
    }

    private launch(mode: GoldMode, p: InstrumentProfile = this.profile) {
        const key = this.sk(mode, p);
        this.running.add(key);
        this.runMode(mode, false, false, p)
            .catch((e) => this.logger.error(`[${p.key}/${mode}] run failed: ${errorMessage(e)}`))
            .finally(() => this.running.delete(key));
    }

    // ---------- one full round: guards -> pull -> AI -> validate -> order ----------

    /**
     * @param p ตราสารของรอบนี้ — ล็อกไว้ตลอดรอบ ไม่อ่านจาก this.profile ระหว่างทาง
     *   ไม่ส่งมา = ใช้ตราสาร active ปัจจุบัน (พฤติกรรมเดิมสำหรับ manual run จาก dashboard/API)
     *   ส่งมาชัดเจน = ให้ tick loop เรียกแต่ละตราสารพร้อมกันได้โดยไม่ชนกัน
     *   (สลับตราสารระหว่างวิเคราะห์ไม่กระทบรอบที่ล็อก p ไว้แล้ว)
     */
    async runMode(
        mode: GoldMode,
        force = false,
        dryRun = false,
        p: InstrumentProfile = this.profile,
    ): Promise<{ decision: GoldDecision | null; outcome: string }> {
        const cfg = { ...MODE_CFG[mode], rrMin: p.modes[mode]?.rrMin ?? MODE_CFG[mode].rrMin };
        // demo role: the round runs for real (data, TA, guards) in a sandbox — its own throwaway state,
        // simulated AI answers, no order, no pending decision, no archive record, no notification
        const demo = demoContext.active;
        const st: ModeState = demo
            ? { lastRunAt: null, lastBarBucket: -1, lastDecision: null, lastOutcome: null, lastError: null }
            : this.getState(mode, p);
        // ปิดรอบ = ติดป้ายตราสาร/โหมดของรอบนี้เสมอ (ห้ามพึ่ง this.currentMode ที่ใช้ร่วมกัน)
        const finish = (d: GoldDecision | null, outcome: string) => this.finish(st, d, outcome, p, mode);
        st.lastRunAt = new Date().toISOString();
        st.lastError = null;
        let archData: GoldExport | null = null;
        let archResult: { decision: GoldDecision | null; outcome: string } | null = null;
        const trace = newTrace(this.configSnapshot(p, mode, cfg.rrMin));
        this.currentMode = mode;

        try {
            // guard: broker connection
            if (!this.ctraderService.isAuthorized) {
                return (archResult = finish(null, 'skipped: cTrader not authorized'));
            }

            // guard: ตลาดปิด (โลหะ: พักรายวัน 17-18 ET / forex: ปิดสุดสัปดาห์) — ห้ามเทรด
            // ไม่ให้ force ข้ามได้ เพราะ broker ไม่รับ order อยู่แล้วตอนตลาดปิด
            const mkt = marketStatus(new Date(), p.hours);
            if (!mkt.open) {
                return (archResult = finish(null, `skipped: ${mkt.reason}`));
            }

            // guard: โหมดนี้ตราสารนี้เทรดไม่ได้ (เช่นทอง swing — ไม้ต่ำสุดเสี่ยงเกินงบอยู่แล้ว)
            // ไม่ให้ force ข้าม เพราะเหตุผลเป็นข้อจำกัดทางกายภาพ ไม่ใช่จังหวะตลาด
            if (!this.tradableModesFor(p).includes(mode)) {
                return (archResult = finish(
                    null,
                    `skipped: ${p.key} does not enable mode ${mode} — the minimum 0.01 lot risks more than the per-trade budget with a wide SL ` +
                        `(enable it via env GOLD_MODES_${p.key})`,
                ));
            }

            // symbolId ของตราสาร — หาไม่เจอ = ห้ามเทรด (broker ไม่มีคู่นี้/ยังไม่ได้ตั้ง env)
            const symbolId = await this.instruments.resolveSymbolId(p);

            // guard: session window / news blackout ตามเวลา ET — bypass with force
            if (!force) {
                const block = this.sessionGuard(mode, p);
                if (block) return (archResult = finish(null, `skipped: ${block}`));
            }

            // guard: scalp daily cap — research consensus: overtrading คือตัวฆ่า
            // scalper เบอร์หนึ่ง เอาเฉพาะ setup คุณภาพไม่กี่ไม้ต่อวันพอ (นับแยกตามตราสาร)
            if (mode === 'scalp') {
                const maxScalps = parseInt(this.cfg('GOLD_SCALP_MAX_PER_DAY', '40'), 10);
                if (this.scalpsToday(p) >= maxScalps) {
                    return (archResult = finish(null, `skipped: scalp limit of ${maxScalps} trades/day reached`));
                }
            }

            // guard: max concurrent positions on this instrument
            const maxOpen = parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS', '20'), 10);
            const openPositions = await this.getOpenPositions(p, symbolId);
            trace.guards.open_positions = openPositions.count;
            if (openPositions.count >= maxOpen) {
                return (archResult = finish(
                    null,
                    `skipped: ${p.key} has ${openPositions.count} open exposures (open positions + pending orders) >= limit ${maxOpen}`,
                ));
            }

            // guard: max concurrent positions รวมทุกตราสาร (เทรดหลายตราสารพร้อมกัน)
            // เพดานต่อตราสารข้างบนกันแต่ละตัวไม่ให้บวมคนเดียว แต่ไม่กันรวมทั้งบัญชี —
            // เปิด XAUUSD 20 + EURUSD 20 + GBPUSD 20 พร้อมกันได้ถ้าไม่มีเพดานนี้
            const maxOpenTotal = parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS_TOTAL', '0'), 10);
            if (maxOpenTotal > 0) {
                const totalOpen = await this.getOpenPositionsAllInstruments();
                trace.guards.open_positions_total = totalOpen;
                if (totalOpen >= maxOpenTotal) {
                    return (archResult = finish(
                        null,
                        `skipped: all instruments combined have ${totalOpen} open exposures >= total limit ${maxOpenTotal}`,
                    ));
                }
            }

            // guard: daily loss stop
            const dailyStop = parseFloat(this.cfg('GOLD_DAILY_MAX_LOSS_USD', '4000'));
            if (dailyStop > 0) {
                const pnl = await this.getTodayPnl();
                trace.guards.daily_pnl_usd = pnl;
                if (pnl === null) {
                    // เช็ค P&L วันนี้ไม่ได้เลย = คุม daily stop ไม่ได้ -> ห้ามเทรด
                    return (archResult = finish(
                        null,
                        "skipped: could not check today's P&L (deal list timed out twice) — no trading until it can be checked",
                    ));
                }
                if (pnl <= -dailyStop) {
                    return (archResult = finish(
                        null,
                        `skipped: daily loss ${pnl.toFixed(2)} USD <= -${dailyStop} (daily stop)`,
                    ));
                }
            }

            // guard: cooldown after a losing close — prevents immediate same-direction
            // re-entry into a move that just ran the SL (2026-08-04 post-mortem:
            // 3 stacked SELLs re-entered into a rally, all stopped out together)
            const cooldownBars = parseInt(this.cfg('GOLD_LOSS_COOLDOWN_BARS', '3'), 10);
            if (cooldownBars > 0 && !force) {
                const lastLossTs = await this.getLastLossCloseTs(symbolId);
                trace.guards.last_loss_close_utc = lastLossTs ? new Date(lastLossTs).toISOString() : null;
                if (lastLossTs === undefined) {
                    // cannot tell whether a loss just closed: skip this round rather than drop the guard
                    return (archResult = finish(
                        null,
                        'skipped: could not check recent losses (deal list unavailable) — no trading until it can be checked',
                    ));
                }
                const cooldownMs = cooldownBars * cfg.periodMin * 60_000;
                if (lastLossTs && Date.now() - lastLossTs < cooldownMs) {
                    const waitMin = Math.ceil((cooldownMs - (Date.now() - lastLossTs)) / 60_000);
                    return (archResult = finish(
                        null,
                        `skipped: loss cooldown — SL was just hit, waiting ${waitMin} more min (${cooldownBars} bars of ${cfg.periodMin}m)`,
                    ));
                }
            }

            // get data — built locally by default (cTrader + Yahoo, same modes as
            // z-service gold.py); GOLD_DATA_SOURCE=remote falls back to the ZIP pull.
            // Either path throws when XAUUSD is unavailable -> no trade this round.
            const data = await this.getData(mode, p);
            archData = data;

            // guard: ข้อมูลต้องครบและสด — ดึงพลาดบางส่วน/แท่งค้างเก่า ห้ามวิเคราะห์
            // (เจอจริง: ProtoOAGetTrendbarsReq timeout ทั้ง 3 TF = ไม่มีราคาให้ดูเลย)
            const dataProblem = this.checkDataIntegrity(mode, data, p);
            if (dataProblem) {
                return (archResult = finish(null, `skipped: ${dataProblem}`));
            }

            // guard: critical companion missing -> cap size at half (§5)
            let sizeCap: GoldSize | null = null;
            if (data.errors) {
                this.logger.warn(`[${mode}] _errors.txt present:\n${data.errors}`);
                if (new RegExp(p.key, 'i').test(data.errors)) {
                    return (archResult = finish(null, `skipped: _errors.txt reports ${p.key} TF failure`));
                }
                sizeCap = 'half';
            }
            trace.guards.size_cap = sizeCap;

            // analysis — GOLD_ENGINE=ta (default): rule-based TA from the pulled
            // indicators (playbook per mode) · =ai: Claude via ANTHROPIC_API_KEY
            const engine = this.engine();
            let decision: GoldDecision;
            if (engine === 'ai' && demo) {
                // demo: no Claude call; the TA decision stands in for the AI engine
                if (!data.series) throw new Error('TA engine requires locally-built series (GOLD_DATA_SOURCE=local)');
                const ta = this.goldTaService.analyze(mode, data.series, { rrMin: cfg.rrMin, sizeCap, profile: p });
                decision = { ...ta, reason: `${ta.reason} | demo: simulated AI engine (no AI provider was called)` };
                trace.base_decision = structuredClone(decision);
            } else if (engine === 'ai') {
                decision = await this.goldAiService.analyze(
                    data,
                    {
                        rrMin: cfg.rrMin,
                        openPositions: openPositions.summary,
                        sizeCap,
                    },
                    p,
                );
                trace.base_decision = structuredClone(decision);
            } else {
                if (!data.series) throw new Error('TA engine requires locally-built series (GOLD_DATA_SOURCE=local)');
                decision = this.goldTaService.analyze(mode, data.series, { rrMin: cfg.rrMin, sizeCap, profile: p });
                trace.base_decision = structuredClone(decision);

                // AI assist — ชั้นเสริมบน TA (เปิด/ปิดได้จากหน้า start loop)
                // ปิดอยู่ / ไม่มีคีย์ / AI ล่ม = ใช้ผล TA เดิมต่อ ไม่สะดุด
                // prompt ปรับตามตราสาร+โหมด และแนบข่าวที่กรองตาม keyword ของตราสาร
                let aiMode = this.aiMode();
                const aiOnly = aiMode === 'ai_only';

                // เพดานการเรียก AI ต่อวัน — ชนแล้วสลับเป็น TA ล้วนอัตโนมัติ "เฉพาะรอบนี้"
                // ระบบไม่หยุด ไม่ error · สวิตช์บน dashboard ยังเป็น lead/assist เหมือนเดิม
                // และกลับมาใช้ AI เองทันทีที่ข้ามวัน UTC หรือกดรีเซ็ตโควตา
                const aiMaxCalls = parseInt(this.cfg('GOLD_AI_MAX_CALLS_PER_DAY', '10'), 10);
                if (aiMode !== 'off') {
                    const u = this.goldGeminiService.usage(aiMaxCalls);
                    if (aiMaxCalls > 0 && u.remaining === 0) {
                        if (!this.aiQuotaWarnedDay.has(u.date_utc)) {
                            this.aiQuotaWarnedDay.add(u.date_utc);
                            this.logger.warn(
                                `Today's AI quota is full (${u.used}/${aiMaxCalls}) — switching to TA only until the next day or a manual reset`,
                            );
                            this.activity.push(
                                'warn',
                                `⚠ AI quota full ${u.used}/${aiMaxCalls} calls today — the bot switched to TA only automatically (still trading normally)`,
                                `${p.key}/${mode}`,
                            );
                        }
                        aiMode = 'off';
                    }
                }

                // โหมด lead: TA ไม่เจอ setup → ให้ AI หาไม้เอง (ไม้ที่ได้ต้องผ่านด่านเข้มกว่า)
                // แต่ไม่ถามทุกรอบ — ผ่านประตู near-miss ก่อน (ดู aiGate())
                trace.guards.ai_mode_this_round = aiMode;
                const gateCheck =
                    aiMode === 'lead' && decision.order_type === 'NO_TRADE'
                        ? this.shouldAskAiForSetup(decision)
                        : { ask: false, why: '' };
                if (aiOnly) {
                    // AI-only (Gemini): the AI proposes every round and TA is not used for the trade.
                    // The proposal passes the same guards as lead mode (half size max, R:R, ATR, market side,
                    // strictness), then min confidence and the risk budget below. Out of quota = no trade,
                    // not a silent switch to TA.
                    if (aiMode === 'off') {
                        decision = {
                            ...decision,
                            order_type: 'NO_TRADE',
                            entry: null,
                            sl: null,
                            tp1: null,
                            tp2: null,
                            rr_tp1: null,
                            reason: 'AI quota is used up for today (AI-only mode) — no trade',
                        };
                        st.lastAssist = null;
                    } else {
                        const news = await this.newsForAssist(p, p.modes[mode]?.news ?? 15);
                        const gotQuota = this.consumeAiQuota(aiMaxCalls);
                        const proposal = gotQuota
                            ? await this.aiPropose(
                                  mode,
                                  data.series ?? null,
                                  {
                                      rrMin: cfg.rrMin,
                                      openPositions: openPositions.summary,
                                      sizeCap,
                                      dailyPnlUsd: this.pnlCache?.value ?? null,
                                  },
                                  { profile: p, news },
                              )
                            : null;
                        decision = this.applyProposal(
                            proposal,
                            cfg.rrMin,
                            sizeCap,
                            p,
                            data.series ?? null,
                            mode,
                            'ai_only',
                        );
                        st.lastAssist = (proposal as any) ?? null;
                        trace.ai_answer = proposal ?? null;
                    }
                } else if (aiMode === 'lead' && decision.order_type === 'NO_TRADE' && !gateCheck.ask) {
                    this.logger.log(`[${mode}] skipping AI: ${gateCheck.why}`);
                    st.lastAssist = null;
                } else if (aiMode === 'lead' && decision.order_type === 'NO_TRADE') {
                    const news = await this.newsForAssist(p, p.modes[mode]?.news ?? 15);
                    // โควตาอาจหมดระหว่าง await news (หลายตราสาร x หลายโหมดยิงพร้อมกัน
                    // และ launch() ไม่ await) — ต้องดูผลตอน "หักจริง" ไม่ใช่ตอนเช็คเพดานข้างบน
                    // หักไม่ได้ = ส่ง null ต่อ ซึ่งเป็นทาง "ไม่มี AI" ที่มีอยู่แล้ว (TA ล้วน)
                    const gotQuota = this.consumeAiQuota(aiMaxCalls);
                    if (!gotQuota)
                        this.logger.warn(
                            `[${p.key}/${mode}] AI quota ran out right before the call — TA only this round`,
                        );
                    const proposal = gotQuota
                        ? await this.aiPropose(
                              mode,
                              data.series ?? null,
                              {
                                  rrMin: cfg.rrMin,
                                  openPositions: openPositions.summary,
                                  sizeCap,
                                  dailyPnlUsd: this.pnlCache?.value ?? null,
                              },
                              { profile: p, news },
                          )
                        : null;
                    const led = this.applyProposal(proposal, cfg.rrMin, sizeCap, p, data.series ?? null, mode);
                    if (led.order_type !== 'NO_TRADE') {
                        this.activity.push(
                            'warn',
                            `🤖 AI found a trade itself (TA found none): ${led.order_type} @ ${fmtPrice(p, led.entry!)} · ${led.playbook_ref}`,
                            `${p.key}/${mode}`,
                        );
                    }
                    decision = led;
                    st.lastAssist = (proposal as any) ?? null;
                    trace.ai_answer = proposal ?? null;
                } else if (aiMode !== 'off' && decision.order_type !== 'NO_TRADE') {
                    const news = await this.newsForAssist(p, p.modes[mode]?.news ?? 15);
                    // โควตาอาจหมดระหว่าง await news (หลายตราสาร x หลายโหมดยิงพร้อมกัน
                    // และ launch() ไม่ await) — ต้องดูผลตอน "หักจริง" ไม่ใช่ตอนเช็คเพดานข้างบน
                    // หักไม่ได้ = ส่ง null ต่อ ซึ่งเป็นทาง "ไม่มี AI" ที่มีอยู่แล้ว (TA ล้วน)
                    const gotQuota = this.consumeAiQuota(aiMaxCalls);
                    if (!gotQuota)
                        this.logger.warn(
                            `[${p.key}/${mode}] AI quota ran out right before the call — TA only this round`,
                        );
                    const assist = gotQuota
                        ? await this.aiAssist(
                              mode,
                              decision,
                              data.series ?? null,
                              {
                                  rrMin: cfg.rrMin,
                                  openPositions: openPositions.summary,
                                  sizeCap,
                                  dailyPnlUsd: this.pnlCache?.value ?? null,
                              },
                              { profile: p, news },
                          )
                        : null;
                    // assist ล้ม (คีย์ผิด/timeout/ตอบไม่ตรง schema) = ไม้ยังยิงต่อด้วย TA ล้วน
                    // ต้องบอกให้เห็น ไม่งั้นสวิตช์ยังเขียวแต่ไม่มีใครตรวจไม้เลย โดยไม่มีอะไรฟ้อง
                    if (!assist) {
                        this.activity.push(
                            'warn',
                            `⚠ AI assist did not answer this round — using the TA result only (check the log for the cause: key/timeout/schema)`,
                            `${p.key}/${mode}`,
                        );
                    }
                    decision = this.applyAssist(decision, assist, cfg.rrMin, p);
                    st.lastAssist = assist;
                    trace.ai_answer = assist ?? null;
                } else {
                    st.lastAssist = null;
                }
            }
            st.lastDecision = decision;

            // validate decision
            if (decision.order_type === 'NO_TRADE') {
                await this.notify(mode, decision, 'NO-TRADE', p);
                return (archResult = finish(decision, `no-trade: ${decision.reason}`));
            }
            const invalid = this.validateDecision(decision, cfg.rrMin);
            if (invalid) {
                await this.notify(mode, decision, `REJECTED (${invalid})`, p);
                return (archResult = finish(decision, `rejected: ${invalid}`));
            }
            const minConf = parseInt(this.cfg('GOLD_MIN_CONFIDENCE', '7'), 10);
            if (decision.confidence < minConf) {
                await this.notify(mode, decision, `SKIPPED (confidence ${decision.confidence} < ${minConf})`, p);
                return (archResult = finish(decision, `skipped: confidence ${decision.confidence} < ${minConf}`));
            }

            // guard: risk budget — ถ้า SL กว้างจนแม้ lot ต่ำสุด (0.01) ยังเสี่ยงเกินงบ
            // ต่อไม้ที่ตั้งไว้ ให้ข้ามไม้นั้น (เจอจริงในโหมด position: SL $314 = เสี่ยง
            // $314 ที่ 0.01 lot ซึ่งเกินงบ $150 สองเท่า)
            const budgetMsg = this.checkRiskBudget(decision, sizeCap, p);
            if (budgetMsg) {
                await this.notify(mode, decision, `SKIPPED (${budgetMsg})`, p);
                return (archResult = finish(decision, `skipped: ${budgetMsg}`));
            }

            // dry run: park the validated decision for a second-opinion review
            // (Claude skill) — /gold/confirm executes it within PENDING_TTL_MS
            if (dryRun && demo) {
                // never parked: a parked decision can be fired by anyone with operator rights
                return (archResult = finish(decision, 'awaiting-approval (demo — not stored, cannot be fired)'));
            }
            if (dryRun) {
                const id = randomUUID().slice(0, 8);
                this.pending.set(this.sk(mode, p), { id, decision, sizeCap, createdAt: Date.now(), trace });
                return (archResult = finish(decision, `awaiting-approval:${id}`));
            }

            if (demo) {
                const sizing = this.sizeOrder(decision.size, sizeCap, decision.entry, decision.sl, p);
                trace.sizing = sizing;
                return (archResult = finish(
                    decision,
                    `order simulated (demo — nothing was sent to the broker): ${sizing.lots} lot`,
                ));
            }

            // place the order
            const uuid = await this.placeOrder(mode, decision, sizeCap, p, symbolId, trace);
            await this.notify(mode, decision, `ORDER SENT (${uuid})`, p);
            return (archResult = finish(decision, `order sent: ${uuid}`));
        } catch (e) {
            st.lastError = errorMessage(e);
            this.logger.error(`[${mode}] ${errorMessage(e)}`);
            await this.telegramService.notifyError(`[${p.key} ${mode}] ${errorMessage(e)}`);
            return (archResult = { decision: st.lastDecision, outcome: `error: ${errorMessage(e)}` });
        } finally {
            // เก็บประวัติทุกรอบเป็น .json ใน /archive (วันเวลา UTC + ไทย)
            trace.market = this.tickSnapshot(p);
            // demo rounds stay out of the archive: it is the record of the real bot (backtests)
            if (!demo) this.archiveRound(mode, archData, archResult, p, trace);
        }
    }

    /** the AI quota is shared and costs money; demo rounds never touch it */
    private consumeAiQuota(max: number): boolean {
        return demoContext.active ? true : this.goldGeminiService.tryConsume(max);
    }

    /** Gemini assist, or in a demo request a simulated answer (no provider is called) */
    private aiAssist(...args: Parameters<GoldGeminiService['assist']>): ReturnType<GoldGeminiService['assist']> {
        if (!demoContext.active) return this.goldGeminiService.assist(...args);
        const ta = args[1];
        return Promise.resolve({
            verdict: 'CONFIRM',
            entry: null,
            sl: null,
            tp1: null,
            tp2: null,
            size: ta.size,
            confidence: ta.confidence,
            key_levels: '',
            risk_note: '',
            reason: 'Simulated AI answer (demo role — no AI provider was called)',
        } as unknown as Awaited<ReturnType<GoldGeminiService['assist']>>);
    }

    /** Gemini proposal (lead / AI only), or in a demo request a simulated "no setup" (no provider is called) */
    private aiPropose(...args: Parameters<GoldGeminiService['propose']>): ReturnType<GoldGeminiService['propose']> {
        if (!demoContext.active) return this.goldGeminiService.propose(...args);
        return Promise.resolve({
            action: 'NO_TRADE',
            order_type: 'NO_TRADE',
            entry: null,
            sl: null,
            tp1: null,
            tp2: null,
            size: 'quarter',
            confidence: 0,
            playbook_ref: '',
            key_levels: '',
            risk_note: '',
            news_risk: '',
            invalidation: '',
            reason: 'Simulated AI answer (demo role — no AI provider was called)',
        } as unknown as Awaited<ReturnType<GoldGeminiService['propose']>>);
    }

    /** ข่าวสำหรับ AI assist — ล้มเหลว/ช้า = ส่งลิสต์ว่าง ไม่ทำให้รอบสะดุด */
    private async newsForAssist(p: InstrumentProfile, limit: number): Promise<any[]> {
        try {
            const timeout = new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 12_000));
            const items = await Promise.race([this.goldBuilderService.fetchNews(limit, p), timeout]);
            return Array.isArray(items) ? items : [];
        } catch (e) {
            this.logger.warn(`news for AI assist failed (${errorMessage(e)}) — sending the prompt without news`);
            return [];
        }
    }

    /** จำนวน scalp ที่ยิงไปแล้ววันนี้ (UTC) ของตราสารนี้ */
    private scalpsToday(p: InstrumentProfile): number {
        const today = new Date().toISOString().slice(0, 10);
        const c = this.scalpCount.get(p.key);
        if (!c || c.day !== today) {
            this.scalpCount.set(p.key, { day: today, count: 0 });
            return 0;
        }
        return c.count;
    }

    /**
     * execute a decision previously parked by runMode(dryRun=true) after review approval
     *
     * The pending entry is claimed synchronously (deleted before the first await), so a second
     * confirm of the same id that arrives while this one is still checking the broker finds nothing
     * and cannot place a second order. A guard that rejects puts the entry back, unless a newer
     * analysis has parked another one meanwhile. If the order went out and only the Telegram notice
     * failed, the call still succeeds and says so in `warning`.
     */
    async confirmPending(
        mode: GoldMode,
        id: string,
    ): Promise<{ uuid: string; decision: GoldDecision; warning?: string }> {
        demoContext.assertNotDemo('Firing a parked decision');
        const prof = this.profile;
        const key = this.sk(mode, prof);
        const p = this.pending.get(key);
        if (!p) throw new DomainError(`no pending decision for ${prof.key} ${mode} — run a dry-run analysis first`);
        if (p.id !== id)
            throw new DomainError(`pending id mismatch (expected ${p.id}) — a newer analysis may have replaced it`);
        if (Date.now() - p.createdAt > PENDING_TTL_MS) {
            this.pending.delete(key);
            throw new DomainError('pending decision expired (>10 min) — market moved, run the analysis again');
        }
        this.pending.delete(key); // claimed: no await happened between the checks above and here

        // re-check hard guards at execution time
        let symbolId: number;
        try {
            if (!this.ctraderService.isAuthorized) throw new DomainError('cTrader not authorized');
            symbolId = await this.instruments.resolveSymbolId(prof);
            const maxOpen = parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS', '20'), 10);
            const open = await this.getOpenPositions(prof, symbolId);
            if (open.count >= maxOpen)
                throw new DomainError(`open ${prof.key} positions ${open.count} >= max ${maxOpen}`);
        } catch (e) {
            if (!this.pending.has(key)) this.pending.set(key, p); // not executed: can be confirmed again
            throw e;
        }

        const uuid = await this.placeOrder(mode, p.decision, p.sizeCap, prof, symbolId, p.trace);
        const st = this.getState(mode, prof);
        st.lastOutcome = `order sent after approval: ${uuid}`;
        const archiveFile = (p as any).archiveFile;
        if (archiveFile) {
            this.ordersService
                .attachMeta(uuid, { archiveFile } as any)
                .catch((e) => this.logger.warn(`attach archiveFile failed: ${errorMessage(e)}`));
        }
        try {
            await this.notify(mode, p.decision, `ORDER SENT after Claude review (${uuid})`, prof);
        } catch (e) {
            this.logger.warn(
                `[${prof.key}/${mode}] order ${uuid} placed, but the notification failed: ${errorMessage(e)}`,
            );
            return { uuid, decision: p.decision, warning: 'order placed, but the Telegram notification failed' };
        }
        return { uuid, decision: p.decision };
    }

    /** discard a parked decision (review rejected it) */
    rejectPending(mode: GoldMode, id: string, reason: string): boolean {
        demoContext.assertNotDemo('Rejecting a parked decision');
        const key = this.sk(mode);
        const p = this.pending.get(key);
        if (!p || p.id !== id) return false;
        this.pending.delete(key);
        const st = this.getState(mode);
        st.lastOutcome = `rejected by review: ${reason}`;
        this.logger.log(`[${mode}] pending ${id} rejected: ${reason}`);
        return true;
    }

    private archiveRound(
        mode: GoldMode,
        data: GoldExport | null,
        result: { decision: GoldDecision | null; outcome: string } | null,
        p: InstrumentProfile = this.profile,
        trace: RoundTrace | null = null,
    ) {
        try {
            const tailN = parseInt(this.configService.get<string>('GOLD_ARCHIVE_BARS', '260'), 10);
            const seriesMeta: Record<string, any> = {};
            const seriesTail: Record<string, any> = {};
            if (data?.series) {
                for (const [k, bars] of Object.entries(data.series)) {
                    const last = bars[bars.length - 1];
                    seriesMeta[k] = {
                        bars: bars.length,
                        last_ts_utc: new Date(last.ts).toISOString(),
                        last_close: last.close,
                    };
                    if (tailN > 0) seriesTail[k] = bars.slice(-tailN);
                }
            }
            const file = this.goldArchiveService.save(mode, {
                instrument: p.key,
                engine: this.engine(),
                ai_assist: this.aiAssistEnabled(),
                outcome: result?.outcome ?? 'unknown',
                decision: result?.decision ?? null,
                data_errors: data?.errors ?? null,
                series_meta: seriesMeta,
                ...(trace ? { context: trace } : {}),
                ...(tailN > 0 && Object.keys(seriesTail).length ? { series_tail: seriesTail } : {}),
            });

            // link the archive file back to what it produced
            const rel = file ? file.split('/').slice(-3).join('/') : null; // archive/<mode>/<file>
            const outcome = result?.outcome ?? '';
            if (rel && outcome.startsWith('order sent: ')) {
                const uuid = outcome.slice('order sent: '.length).trim();
                this.ordersService
                    .attachMeta(uuid, { archiveFile: rel } as any)
                    .catch((e) => this.logger.warn(`attach archiveFile failed: ${errorMessage(e)}`));
            } else if (rel && outcome.startsWith('awaiting-approval:')) {
                const pend = this.pending.get(this.sk(mode, p));
                if (pend) (pend as any).archiveFile = rel; // carried into the order on confirm
            }
        } catch (e) {
            this.logger.error(`archiveRound failed: ${errorMessage(e)}`);
        }
    }

    /**
     * @param p,mode ตราสาร/โหมดของรอบนี้ — ใช้ติดป้าย activity log
     *   ไม่ส่งมา = ถอยไปใช้ this.currentMode แบบเดิม
     *   ต้องส่งเสมอเมื่อรันหลายตราสารพร้อมกัน เพราะ currentMode เป็นตัวแปรตัวเดียว
     *   ที่ทุกตราสารเขียนทับกัน -> ป้ายโหมดสลับมั่ว และไม่บอกว่าเป็นตราสารไหน
     */
    private finish(
        st: ModeState,
        decision: GoldDecision | null,
        outcome: string,
        p?: InstrumentProfile,
        mode?: GoldMode,
    ) {
        st.lastOutcome = outcome;
        const tag = p && mode ? `${p.key}/${mode}` : this.currentMode;
        this.logger.log(p ? `[${p.key}/${mode}] ${outcome}` : outcome);
        const level: 'ok' | 'warn' | 'error' | 'info' = outcome.startsWith('order sent')
            ? 'ok'
            : outcome.startsWith('error')
              ? 'error'
              : outcome.startsWith('awaiting')
                ? 'warn'
                : 'info';
        this.activity.push(level, outcome, tag);
        if (decision && decision.order_type !== 'NO_TRADE') {
            this.activity.push(
                level === 'ok' ? 'ok' : 'info',
                `${decision.order_type} @ ${decision.entry} · SL ${decision.sl} · TP1 ${decision.tp1} · R:R ${decision.rr_tp1} · conf ${decision.confidence}/10 · ${decision.playbook_ref}`,
                tag,
            );
        }
        return { decision, outcome };
    }

    // ---------- helpers ----------

    async getData(mode: GoldMode, p: InstrumentProfile = this.profile): Promise<GoldExport> {
        const source = this.configService.get<string>('GOLD_DATA_SOURCE', 'local').toLowerCase();
        // ข่าวฝังใน formula มีไว้ให้ AI engine อ่านเท่านั้น — TA อ่านตัวเลขอย่างเดียว
        // จึงไม่เสียเวลาดึง RSS ในโหมดปกติ (Claude ดูข่าวผ่าน GET /gold/news แทน)
        const withNews = this.engine() === 'ai';
        if (source === 'remote') {
            // ZIP จาก z-service มีแต่ชุดทอง — ตราสารอื่นต้องสร้างข้อมูลในตัวเท่านั้น
            if (p.key !== 'XAUUSD')
                throw new Error(`GOLD_DATA_SOURCE=remote supports XAUUSD only — ${p.key} must use local`);
            return this.goldDataService.fetchExport(mode);
        }
        return this.goldBuilderService.build(mode, withNews, p);
    }

    private etInfo(now = new Date()): { min: number; dow: number } {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            weekday: 'short',
            hour: 'numeric',
            minute: 'numeric',
        }).formatToParts(now);
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
        const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        return {
            min: (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10),
            dow: dowMap[get('weekday')] ?? 0,
        };
    }

    /**
     * returns a reason to skip, or null if the session allows new entries
     * หน้าต่าง/blackout มาจาก profile.session (นาที ET) — ของทองเท่าค่าเดิมทุกตัว
     */
    private sessionGuard(mode: GoldMode, p: InstrumentProfile = this.profile): string | null {
        if (mode === 'swing' || mode === 'position') return null; // higher TFs trade any session
        const { min, dow } = this.etInfo();
        const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        for (const b of p.session.blackouts) {
            if (min >= b.from && min < b.to) return b.label_th;
        }
        if (p.session.fridayCutoff != null && dow === 5 && min >= p.session.fridayCutoff) {
            return 'Friday afternoon ET — no new trades before the weekly close';
        }
        if (mode === 'scalp') {
            const inWindow = p.session.scalpWindows.some(([a, b]) => min >= a && min < b);
            if (!inWindow) {
                return `outside the scalp window (${p.session.scalpWindows.map(([a, b]) => `${hhmm(a)}-${hhmm(b)} ET`).join(' / ')})`;
            }
        }
        if (mode === 'intraday') {
            const [a, b] = p.session.intradayWindow;
            if (!(min >= a && min < b)) return `outside the intraday window (${hhmm(a)}–${hhmm(b)} ET)`;
        }
        return null;
    }

    /** ไม้ที่เปิดอยู่ของตราสารนี้ (นับตาม symbolId) — lots คำนวณจาก unitsPerLot ของตราสาร */
    /**
     * นับ "ภาระที่ค้างอยู่" ของตราสารนี้ = ไม้ที่เปิดแล้ว + ออเดอร์รอที่ยังไม่ถูก fill
     *
     * ต้องนับ pending ด้วย ไม่งั้นเพดานไม้ค้างกันอะไรไม่ได้เลย:
     * ออเดอร์รอ 3 ไม้ที่ราคาเดียวกันจะ fill พร้อมกันภายในวินาทีเดียว แล้วทะลุเพดานทันที
     * (26 ส.ค. 2569 เกิดจริง: เพดาน 4 แต่มีไม้ 5 — scalp วาง SELL LIMIT @4623.53
     *  ไว้ 3 ไม้เมื่อ 13:35/13:40/13:45 แล้ว fill พร้อมกันหมดตอน 13:46:42
     *  ตอนวางแต่ละครั้งเห็นไม้เปิดแค่ 2 ไม้ ด่านจึงปล่อยผ่านทุกครั้ง)
     */
    private async getOpenPositions(
        p: InstrumentProfile,
        symbolId: number,
    ): Promise<{ count: number; summary: string }> {
        try {
            const res = await this.ctraderService.getPositions();
            const positions = (res?.position ?? []) as any[];
            const orders = (res?.order ?? []) as any[];
            const mine = positions.filter((pos) => Number(pos.tradeData?.symbolId ?? 0) === symbolId);
            const pending = orders.filter((o) => Number(o.tradeData?.symbolId ?? 0) === symbolId);

            const lotsOf = (td: any) => Number(td?.volume ?? 0) / (p.unitsPerLot * 100);
            const parts = mine.map((pos) => {
                const side = pos.tradeData?.tradeSide === 1 ? 'BUY' : 'SELL';
                return `${side} ${lotsOf(pos.tradeData)} lots @ ${pos.price}`;
            });
            for (const o of pending) {
                const side = o.tradeData?.tradeSide === 1 ? 'BUY' : 'SELL';
                const px = o.limitPrice ?? o.stopPrice ?? '-';
                parts.push(`(pending) ${side} ${lotsOf(o.tradeData)} lots @ ${px}`);
            }
            return { count: mine.length + pending.length, summary: parts.join(' | ') };
        } catch (e) {
            this.logger.warn(`getPositions failed (${errorMessage(e)}) — assuming 0 open`);
            return { count: 0, summary: 'unknown (reconcile failed)' };
        }
    }

    /**
     * นับภาระค้างรวมทุกตราสารที่ระบบรู้จัก (ไม้เปิด + ออเดอร์รอ) — ใช้กับเพดานรวม
     * เรียก broker ครั้งเดียว (ตัวเดียวกับที่ getOpenPositions ใช้) แล้วกรองด้วย
     * profileBySymbolId แทนการเทียบ symbolId ตัวเดียว — เผื่อ symbol ที่ resolveAll
     * ยังไปไม่ถึง (broker ไม่มีคู่นั้น) จะไม่ถูกนับเป็นภาระเพราะไม่รู้จักเลย
     */
    private async getOpenPositionsAllInstruments(): Promise<number> {
        try {
            const res = await this.ctraderService.getPositions();
            const known = (list: any[]) =>
                list.filter((x) => !!this.instruments.profileBySymbolId(Number(x.tradeData?.symbolId ?? 0))).length;
            return known((res?.position ?? []) as any[]) + known((res?.order ?? []) as any[]);
        } catch (e) {
            this.logger.warn(`getOpenPositionsAllInstruments failed (${errorMessage(e)}) — assuming 0`);
            return 0;
        }
    }

    /**
     * P&L of the UTC day (from the last daily-stop reset, if any), from the shared deal cache.
     * `null` = cannot be checked: the caller must fail closed (unknown P&L = no trading).
     */
    private async getTodayPnl(): Promise<number | null> {
        const now = new Date();
        const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        // กด "เคลียร์ daily stop" = ขยับจุดเริ่มนับมาที่เวลาที่กด · ไม้ที่ปิดก่อนหน้านั้นไม่นับอีก
        // แต่ไม้ที่ปิด "หลัง" จุดนั้นยังนับปกติ = ด่านยังทำงานต่อ ตัดซ้ำได้ถ้าขาดทุนใหม่ถึงเพดาน
        const reset = this.activeDailyStopReset();
        const from = reset ? Math.max(midnight, reset.ts) : midnight;
        try {
            const { deals, stale, ageMs } = await this.deals.closedSince(from);
            const pnl = deals.reduce((sum, d) => sum + d.netUsd, 0);
            if (stale) {
                this.activity.push(
                    'warn',
                    `deal list unavailable — using P&L ${pnl.toFixed(2)} USD from ${Math.round(ageMs / 60_000)} min ago`,
                    this.currentMode,
                );
            }
            this.pnlCache = { value: pnl, ts: Date.now() - ageMs };
            return pnl;
        } catch (e) {
            this.logger.warn(`getTodayPnl failed: ${errorMessage(e)}`);
            return null;
        }
    }

    private validateDecision(d: GoldDecision, rrMin: number): string | null {
        if (!d.entry || !d.sl || !d.tp1) return 'missing entry/sl/tp1';
        if (!d.playbook_ref) return 'no playbook reference';
        if (d.rr_tp1 == null || d.rr_tp1 < rrMin) return `rr_tp1 ${d.rr_tp1} < mode minimum ${rrMin}`;

        const isBuy = d.order_type.startsWith('BUY');
        if (isBuy && !(d.sl < d.entry && d.tp1 > d.entry)) return 'BUY but SL/TP not on correct sides of entry';
        if (!isBuy && !(d.sl > d.entry && d.tp1 < d.entry)) return 'SELL but SL/TP not on correct sides of entry';

        // cross-check the claimed R:R against the actual prices (10% tolerance)
        const risk = Math.abs(d.entry - d.sl);
        const reward = Math.abs(d.tp1 - d.entry);
        if (risk <= 0) return 'zero risk distance';
        if (reward / risk < rrMin * 0.9) return `computed R:R ${(reward / risk).toFixed(2)} < mode minimum ${rrMin}`;

        if (d.valid_until_utc) {
            const t = Date.parse(d.valid_until_utc);
            if (isNaN(t) || t <= Date.now()) return `valid_until_utc invalid or already past (${d.valid_until_utc})`;
        }
        return null;
    }

    /**
     * ด่านความสมบูรณ์ของข้อมูล — null = ผ่าน · string = เหตุผลที่ห้ามวิเคราะห์รอบนี้
     * ตรวจ 3 อย่าง: (1) XAUUSD ทุก TF ที่โหมดต้องใช้มาครบ (2) จำนวนแท่งพอ
     * (3) แท่งล่าสุดยังสด ไม่ใช่ข้อมูลค้างจากรอบก่อน/ตลาดปิด
     */
    private checkDataIntegrity(mode: GoldMode, data: GoldExport, p: InstrumentProfile = this.profile): string | null {
        if (!data.series) return null; // remote ZIP path — no series to check
        const required = p.modes[mode].sets.filter((s) => s.symbol === p.key);
        const staleMult = parseFloat(this.configService.get<string>('GOLD_MAX_BAR_AGE_MULT', '3'));

        for (const { tf, nBars } of required) {
            const key = seriesKey(p, tf);
            const bars = data.series[key];
            if (!bars?.length) {
                return `Could not fetch ${p.key} ${tf} data — no trading this round (${data.errors ?? 'unknown cause'})`;
            }
            const minBars = Math.min(60, nBars);
            if (bars.length < minBars) {
                return `${p.key} ${tf} has only ${bars.length}/${minBars} bars — not enough data to analyze`;
            }
            const ageMs = Date.now() - bars[bars.length - 1].ts;
            // TF รายวัน/รายสัปดาห์: ต้องเผื่อช่วงที่ตลาดปิด ไม่งั้นเช้าวันจันทร์
            // แท่ง 1d ล่าสุดคือของวันศุกร์ = เก่า ~2.6 วัน ชน 3×TF พอดี → swing/position
            // ถูกบล็อกทิ้งทั้งวันจันทร์ทุกสัปดาห์ (นับเวลาที่ตลาดไม่เปิดเป็น "ข้อมูลค้าง")
            const weekendAllowance = tf === '1d' || tf === '1w' ? 2 * 86_400_000 : 0;
            const maxAge = INTERVAL_MS[tf] * staleMult + weekendAllowance;
            if (ageMs > maxAge) {
                const mins = Math.round(ageMs / 60_000);
                return `Latest ${p.key} ${tf} bar is ${mins} min old (over ${staleMult}×TF) — stale data/market closed, no trading`;
            }
        }
        return null;
    }

    /** null = ผ่าน · string = เหตุผลที่ไม้นี้เสี่ยงเงินเกินงบแม้ใช้ lot ต่ำสุด */
    private checkRiskBudget(
        d: GoldDecision,
        sizeCap: GoldSize | null,
        p: InstrumentProfile = this.profile,
    ): string | null {
        // เดิม: sizing=fixed แล้ว return null = ปิดด่านงบความเสี่ยงทิ้งทั้งด่าน
        // ซึ่งเป็นโหมดที่ "ไม่คุม lot ตามระยะ SL" อยู่แล้ว ยิ่งต้องคุมงบ ไม่ใช่ปล่อยผ่าน
        // (โหมด fixed + AI ถ่าง SL กว้าง = เสี่ยงเงินทะลุงบโดยไม่มีอะไรห้ามเลย)
        if (d.entry == null || d.sl == null) return null;
        const riskUsd = parseFloat(this.cfg('GOLD_RISK_USD_PER_TRADE', '1500'));
        const tolerance = parseFloat(this.cfg('GOLD_RISK_TOLERANCE', '1.2'));
        const lots = this.resolveVolume(d.size, sizeCap, d.entry, d.sl, p);
        // มูลค่าต่อ 1.0 หน่วยราคา ต่อ lot: ทอง $100 · EURUSD $100,000 · USDJPY 100,000/ราคา
        const actualRisk = Math.abs(d.entry - d.sl) * usdPerUnitMovePerLot(p, d.entry) * lots;
        if (actualRisk > riskUsd * tolerance) {
            return `SL width ${fmtPrice(p, Math.abs(d.entry - d.sl))} → actual risk $${actualRisk.toFixed(0)} at ${lots} lot exceeds the budget $${riskUsd} (even the 0.01 min lot exceeds it)`;
        }
        return null;
    }

    /**
     * เพดาน lot ของตราสารนี้ — ลำดับ: GOLD_MAX_LOT_<KEY> > GOLD_MAX_LOT (ทองเท่านั้น) > profile.maxLot
     *
     * เดิม GOLD_MAX_LOT ตัวเดียวคุมทุกตราสาร แต่ "1 lot" ทองกับ FX ต่างกัน 1,000 เท่า
     * (100 oz vs 100,000 หน่วย) ตั้งให้ทองปลอดภัย = FX เล็กจนไม่มีความหมาย
     * GOLD_MAX_LOT จึงเหลือคุมเฉพาะทองตามชื่อของมัน (ของเดิมไม่พัง)
     * ตราสารอื่นตั้งแยกได้ที่ GOLD_MAX_LOT_EURUSD / _GBPUSD / _USDJPY
     */
    private maxLotFor(p: InstrumentProfile): number {
        const per = this.cfg(`GOLD_MAX_LOT_${p.key}`, '');
        if (per) {
            const v = parseFloat(per);
            if (v > 0) return v;
        }
        if (p.key === 'XAUUSD') {
            const g = this.cfg('GOLD_MAX_LOT', '');
            if (g) {
                const v = parseFloat(g);
                if (v > 0) return v;
            }
        }
        return p.maxLot;
    }

    private resolveVolume(
        size: GoldSize,
        cap: GoldSize | null,
        entry?: number | null,
        sl?: number | null,
        p: InstrumentProfile = this.profile,
    ): number {
        return this.sizeOrder(size, cap, entry, sl, p).lots;
    }

    /** lot size and every input that produced it (recorded on the order for backtests) */
    private sizeOrder(
        size: GoldSize,
        cap: GoldSize | null,
        entry?: number | null,
        sl?: number | null,
        p: InstrumentProfile = this.profile,
    ): RoundSizing {
        const factor: Record<GoldSize, number> = { full: 1, half: 0.5, quarter: 0.25 };
        const capOrder: Record<GoldSize, number> = { quarter: 1, half: 2, full: 3 };
        const effective: GoldSize = cap && capOrder[cap] < capOrder[size] ? cap : size;
        const maxLot = this.maxLotFor(p);
        const sizing = this.cfg('GOLD_SIZING', 'risk').toLowerCase();

        let lots: number;
        let riskUsd: number | null = null;
        let perUnit: number | null = null;
        const slDist = entry != null && sl != null ? Math.abs(entry - sl) : 0;
        if (sizing === 'risk' && slDist > 0) {
            // fixed-risk sizing (consensus best practice): ทุกไม้เสี่ยง $ เท่ากัน
            // ไม่ว่า SL กว้างแค่ไหน — post-mortem เดิม: fixed lots ทำให้ไม้ position
            // (SL 314$) เสี่ยงเงินมากกว่าไม้ intraday (SL 17$) ถึง ~18 เท่า
            // XAUUSD: 1 lot = 100 oz → $1 move = $100/lot · FX: 1 lot = 100k → 1 pip = $10 (USD-quoted)
            riskUsd = parseFloat(this.cfg('GOLD_RISK_USD_PER_TRADE', '1500'));
            perUnit = usdPerUnitMovePerLot(p, entry!);
            lots = (riskUsd * factor[effective]) / (slDist * perUnit);
        } else {
            const base = parseFloat(this.cfg('GOLD_BASE_LOT', '0.1'));
            lots = base * factor[effective];
        }
        return {
            method: sizing === 'risk' && slDist > 0 ? 'risk' : 'fixed',
            size,
            size_cap: cap,
            effective_size: effective,
            sl_distance: slDist,
            risk_usd: riskUsd,
            usd_per_unit_per_lot: perUnit,
            raw_lots: lots,
            max_lot: maxLot,
            lots: Math.min(maxLot, Math.max(0.01, Math.round(lots * 100) / 100)),
        };
    }

    /**
     * Time of the latest losing close on this symbol in the last 24 h; `null` = none.
     * `undefined` = could not be checked: the cooldown guard must then NOT assume "no recent loss".
     */
    private async getLastLossCloseTs(symbolId: number): Promise<number | null | undefined> {
        try {
            const { deals } = await this.deals.closedSince(Date.now() - 24 * 3_600_000);
            let last: number | null = null;
            for (const d of deals) {
                if (d.symbolId !== symbolId || d.netUsd >= 0) continue;
                if (!last || d.closedAt > last) last = d.closedAt;
            }
            return last;
        } catch (e) {
            this.logger.warn(`getLastLossCloseTs failed: ${errorMessage(e)}`);
            return undefined;
        }
    }

    private async placeOrder(
        mode: GoldMode,
        d: GoldDecision,
        sizeCap: GoldSize | null,
        p: InstrumentProfile,
        symbolId: number,
        trace: RoundTrace | null = null,
    ): Promise<string> {
        // one working pending order per mode per instrument — a new round REPLACES the previous
        // order instead of stacking on top of it (post-mortem: stacked limits
        // filled together and multiplied one loss by 3)
        try {
            const rec = await this.ctraderService.getPositions(); // reconcile: positions + orders
            const stale = ((rec?.order ?? []) as any[]).filter(
                (o) =>
                    Number(o.tradeData?.symbolId ?? 0) === symbolId &&
                    String(o.clientOrderId ?? '').startsWith(`gold-${mode}-`),
            );
            for (const o of stale) {
                await this.ctraderService.cancelOrder(Number(o.orderId));
                this.logger.log(`[${mode}] cancelled stale pending order ${o.orderId} (replaced by new round)`);
            }
        } catch (e) {
            this.logger.warn(`stale-order cleanup failed: ${errorMessage(e)}`);
        }

        const uuid = `gold-${mode}-${randomUUID()}`;
        const side = d.order_type.startsWith('BUY') ? 'BUY' : 'SELL';
        const orderType = d.order_type.endsWith('LIMIT') ? 'LIMIT' : 'STOP';
        const sizing = this.sizeOrder(d.size, sizeCap, d.entry, d.sl, p);
        const volume = sizing.lots;
        if (trace) trace.sizing = sizing;

        if (mode === 'scalp') {
            const n = this.scalpsToday(p);
            this.scalpCount.set(p.key, { day: new Date().toISOString().slice(0, 10), count: n + 1 });
        }

        const orderParams: any = {
            uuid,
            symbol: p.symbolName,
            symbolId, // ExecutionService uses this directly, no name lookup needed
            unitsPerLot: p.unitsPerLot, // gold 100 oz · FX 100,000
            side,
            orderType,
            volume,
            price: d.entry,
            stopLoss: d.sl,
            takeProfit: d.tp1,
            strategy: 'GOLD_AI',
            mode: mode.toUpperCase(),
        };
        if (d.valid_until_utc) {
            orderParams.expirationTimestamp = Date.parse(d.valid_until_utc); // cTrader cancels the pending order itself
        }

        await this.ordersService.createOrder({
            uuid,
            symbol: p.symbolName,
            side,
            orderType,
            volume,
            price: d.entry!,
            stopLoss: d.sl!,
            takeProfit: d.tp1!,
            strategy: 'GOLD_AI',
            mode: mode.toUpperCase(),
            status: 'PENDING',
            message: `${d.order_type} rr=${d.rr_tp1} conf=${d.confidence} ${d.playbook_ref} | ${d.reason}`,
            engine: this.engine(),
            reason: d.reason,
            playbookRef: d.playbook_ref,
            invalidation: d.invalidation,
            tp2: d.tp2 ?? undefined,
            rrTp1: d.rr_tp1 ?? undefined,
            confidence: d.confidence,
            analysisSummary: d.analysis_summary,
            ...(trace
                ? {
                      configHash: trace.config_hash,
                      riskProfile: trace.config.risk_profile
                          ? `${trace.config.risk_profile.name}${trace.config.risk_profile.modified ? ' (modified)' : ''}`
                          : 'custom',
                      context: { ...trace, market: this.tickSnapshot(p) },
                  }
                : {}),
        });
        if (trace) {
            const r = trace.config;
            this.activity.push(
                'ok',
                `order ${uuid.slice(-8)} · ${sizing.lots} lot · profile ${r.risk_profile?.name ?? 'custom'}${r.risk_profile?.modified ? '*' : ''} · risk $${r.risk.risk_usd_per_trade} · ${r.engine === 'ai' ? 'Claude engine' : `AI ${trace.guards.ai_mode_this_round ?? r.ai.mode_effective}`} (${r.ai.model}, ${r.ai.thinking}, ${r.ai.strictness}) · config ${trace.config_hash}`,
                `${p.key}/${mode}`,
            );
        }

        await this.executionService.executeOrder(orderParams);
        return uuid;
    }

    private async notify(mode: GoldMode, d: GoldDecision, headline: string, p: InstrumentProfile = this.profile) {
        if (demoContext.active) return; // demo rounds never notify the real chat
        const lines = [
            `${p.emoji} <b>[${p.key} ${mode.toUpperCase()}] ${headline}</b>`,
            d.order_type !== 'NO_TRADE'
                ? `${d.order_type} @ ${d.entry} | SL ${d.sl} | TP1 ${d.tp1}${d.tp2 ? ` | TP2 ${d.tp2}` : ''} | R:R ${d.rr_tp1} | conf ${d.confidence}/10 | size ${d.size}`
                : // reason/invalidation/analysis_summary carry free text from the AI
                  // (applyAssist/applyProposal ยัด ai.reason, pr.invalidation ฯลฯ ลงไป)
                  // ไม่ escape = ตัว < > & ตัวเดียวทำให้ Telegram ทิ้งทั้งข้อความ
                  // = ออเดอร์ยิงจริงแต่ไม่มีใครรู้ (บั๊กเดียวกับที่เคยแก้ไปแล้วรอบหนึ่ง)
                  `Reason: ${this.esc(d.reason)}`,
            d.invalidation ? `❌ Invalidation: ${this.esc(d.invalidation)}` : '',
            ...this.assistLines(d),
            d.valid_until_utc ? `⏳ valid until ${this.esc(d.valid_until_utc)}` : '',
            '',
            this.esc(d.analysis_summary),
        ].filter(Boolean);
        await this.telegramService.notifyOrderSuccess(lines.join('\n'));
    }
}
