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
    isInstrumentKey,
    fmtPrice,
    roundPrice,
    seriesKey,
    usdPerUnitMovePerLot,
} from './domain/instruments';
import { errorMessage } from '../common/utils/errors';
import { DomainError } from './domain/domain-error';

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
}

const PENDING_TTL_MS = 10 * 60_000; // decision goes stale after 10 minutes
const PNL_CACHE_TTL_MS = 10 * 60_000; // ใช้ P&L ที่แคชไว้ได้ไม่เกิน 10 นาที เมื่อ deal list ล่ม
const TA_MAX_CONFIDENCE = 8; // เพดานคะแนนที่ TA engine สร้างได้จริง (ดู gold-ta.service.ts confBase)
const STALE_TICK_MS = 90_000; // ตลาดเปิดแต่ราคาไม่ขยับเกิน 90 วิ = subscription เงียบ
const SPOT_RESUB_COOLDOWN_MS = 60_000; // กันสมัครรับราคาใหม่รัว ๆ ทุก tick

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
    private lastSpotResubAt = new Map<string, number>(); // key = instrument -> เวลาที่พยายามสมัครล่าสุด (กันยิงถี่ต่อตราสาร)
    // นับ scalp ต่อวัน แยกตามตราสาร (key = instrument)
    private scalpCount = new Map<string, { day: string; count: number }>();
    // สมัครรับราคาสดของหลายตราสารพร้อมกันได้ (loop วนหลายตราสาร) — key = instrument key
    private spotSubscribed = new Map<string, boolean>();
    private spotSymbolId = new Map<string, number>(); // instrument key -> symbolId ที่สมัครรับราคาสดอยู่
    private lastHeartbeat = 0;
    private currentMode: GoldMode | null = null;
    private marketWasOpen = new Map<string, boolean>(); // key = instrument -> ตลาดตราสารนั้นเปิดอยู่ไหมในรอบก่อน (แต่ละตราสารเวลาตลาดต่างกัน)
    // state/pending/running แยกตามตราสาร: key = `${instrument}:${mode}` — สลับตราสารแล้วของเดิมไม่หาย
    private running = new Set<string>();
    private state = new Map<string, ModeState>();
    private pending = new Map<string, PendingApproval>();
    private lastPositionRunDate = new Map<string, string>(); // key = instrument -> วันที่รัน position ล่าสุด
    // runtime overrides (from POST /gold/automate) — null = follow env
    private runtimeEnabled: boolean | null = null;
    private runtimeModes: GoldMode[] | null = null;
    private runtimeInstruments: string | null = null; // comma-separated keys, null = ตราสาร active ตัวเดียว

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
        if (this.isEnabled()) throw new DomainError('หยุด Auto Loop ก่อน แล้วค่อยเปลี่ยนตราสาร');
        if (this.running.size) throw new DomainError('กำลังวิเคราะห์รอบอยู่ — รอให้จบก่อนเปลี่ยนตราสาร');
        const before = this.profile.key;
        const p = this.instruments.setActive(symbol);
        if (p.key !== before) {
            // ไม่ต้องล้าง tick/subscription/marketWasOpen อีกต่อไป — ทุกอย่างเป็น Map
            // แยกตามตราสารอยู่แล้ว (key = instrument key) สลับไปสลับมาไม่ชนกันเอง
            // และราคา/สถานะของตราสารเดิมยังอยู่ครบ สลับกลับมาใช้ต่อได้ทันทีตามคอมเมนต์ข้างบน
            this.activity.push(
                'warn',
                `${p.emoji} เปลี่ยนตราสารเป็น ${p.key} (${p.name_th}) — ข้อมูล/playbook/AI prompt/ข่าว/ชั่วโมงตลาด ปรับตามแล้ว`,
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
        if (!prof) return; // symbol ที่ระบบไม่รู้จัก (เช่น klines gateway subscribe เพิ่ม) ไม่เกี่ยวกับ gold bot
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
                this.activity.push('error', `หา symbolId ของ ${p.key} ไม่ได้: ${errorMessage(e)}`);
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
            this.logger.warn(`ราคาสด ${p.key} ค้าง ${Math.round(tickAge / 60_000)} นาที — รื้อ subscription สมัครใหม่`);
            this.activity.push(
                'warn',
                `⚠ ราคาสด ${p.key} ค้าง ${Math.round(tickAge / 60_000)} นาที — กำลังสมัครรับราคาใหม่`,
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
            this.activity.push('ok', `สมัครรับราคา ${p.key} สดจาก cTrader แล้ว`);
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
        this.activity.push('info', 'Gold service เริ่มทำงาน — รอสัญญาณ');
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
                ? '✅ AI ยืนยันระดับเดิม'
                : ai.verdict === 'ADJUST'
                  ? '✏️ AI ขยับระดับให้'
                  : '🛑 AI ไม่ให้เข้าไม้นี้';
        return [
            '',
            `🤖 <b>${mark}</b> (มั่นใจ ${ai.confidence}/10)`,
            ai.reason_th ? `• เหตุผล: ${this.esc(ai.reason_th)}` : '',
            ai.key_levels ? `• แนวที่ใช้ตัดสิน: ${this.esc(ai.key_levels)}` : '',
            ai.risk_note_th ? `• ⚠ ระวัง: ${this.esc(ai.risk_note_th)}` : '',
            (ai as any).news_risk_th ? `• 📰 ข่าว/ปฏิทิน: ${this.esc((ai as any).news_risk_th)}` : '',
            (ai as any).invalidation_th ? `• ❌ ไม้ตายเมื่อ: ${this.esc((ai as any).invalidation_th)}` : '',
        ].filter(Boolean);
    }

    /** เปิด AI ช่วยหาจุดเข้าอยู่ไหม — สวิตช์จาก dashboard ทับค่า env GOLD_AI_ASSIST */
    /**
     * โหมด AI: off = ไม่ใช้ · assist = ตรวจไม้ที่ TA หามา (ลดความเสี่ยงได้อย่างเดียว)
     * · lead = assist + ถ้า TA ไม่เจอ setup ให้ AI หาไม้เอง (ผ่านด่านเข้มกว่า + ขนาดไม้ไม่เกินครึ่ง)
     * รองรับ GOLD_AI_ASSIST=true แบบเดิม = assist
     */
    aiMode(): 'off' | 'assist' | 'lead' {
        const raw = this.cfg('GOLD_AI_MODE', '').toLowerCase();
        const mode =
            raw === 'lead' || raw === 'assist' || raw === 'off'
                ? raw
                : this.cfg('GOLD_AI_ASSIST', 'false').toLowerCase() === 'true'
                  ? 'assist'
                  : 'off';
        if (mode === 'off') return 'off';
        if (!this.goldGeminiService.config.has_key) {
            if (!this.assistKeyWarned) {
                this.assistKeyWarned = true;
                this.logger.warn(`AI mode=${mode} แต่ไม่มี GEMINI_API_KEY — ถือว่าปิด ใช้ TA ล้วน`);
                this.activity.push('warn', `AI mode เปิดไว้ (${mode}) แต่ไม่มี GEMINI_API_KEY — ระบบใช้ TA ล้วน`);
            }
            return 'off';
        }
        return mode;
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
                reason: `AI ไม่ให้เข้า: ${ai.reason_th || 'ไม่ระบุเหตุผล'}`,
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
                ? Math.min(taRiskForDrift * 0.5, ta.entry * 0.006) // ครึ่งหนึ่งของระยะ SL และไม่เกิน 0.6%
                : ta.entry * 0.006;
        if (driftAbs > driftCap) {
            this.logger.warn(
                `[AI] ขยับ entry ${driftAbs.toFixed(2)} เกินเพดาน ${driftCap.toFixed(2)} ` +
                    `(ครึ่งของระยะ SL ${taRiskForDrift.toFixed(2)}) — ใช้ระดับของ TA แทน`,
            );
            return { ...d, size, confidence: conf };
        }
        // SL ผิดฝั่ง = ใช้ของ TA
        if ((isBuy && sl >= entry) || (!isBuy && sl <= entry)) {
            this.logger.warn('[AI] SL อยู่ผิดฝั่งของ entry — ใช้ระดับของ TA แทน');
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
                reason: `AI ขยับแล้ว R:R เหลือ ${rr.toFixed(2)} ต่ำกว่าขั้นต่ำ ${rrMin} — ไม่เข้า`,
            };
        }

        // SL ต้องไม่แคบกว่าของ TA เกินครึ่ง — sizing แบบ risk คำนวณ lot จาก 1/ระยะ SL
        // AI บีบ SL แคบ = lot พองทวีคูณจนชน GOLD_MAX_LOT ทั้งที่ "เสี่ยงเท่าเดิม" บนกระดาษ
        const taRisk = ta.entry != null && ta.sl != null ? Math.abs(ta.entry - ta.sl) : 0;
        if (taRisk > 0 && risk < taRisk * 0.5) {
            this.logger.warn(
                `[AI] บีบ SL จาก ${taRisk.toFixed(2)} เหลือ ${risk.toFixed(2)} (< ครึ่งของ TA) — ใช้ระดับของ TA แทน`,
            );
            return { ...d, size, confidence: conf };
        }
        // ...และต้องไม่ถ่าง SL เกิน 2 เท่าของ TA ด้วย (เดิมคุมแค่ฝั่งแคบ)
        // ถ่าง SL = ระยะขาดทุนต่อไม้ยาวขึ้นจริง ๆ แม้ lot จะเล็กลงตามสูตร risk
        // applyProposal คุมสองฝั่งด้วย ATR อยู่แล้ว ทางนี้ซึ่งใช้บ่อยกว่ากลับไม่มีเพดานบน
        if (taRisk > 0 && risk > taRisk * 2) {
            this.logger.warn(
                `[AI] ถ่าง SL จาก ${taRisk.toFixed(2)} เป็น ${risk.toFixed(2)} (> 2 เท่าของ TA) — ใช้ระดับของ TA แทน`,
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
                `[AI] ไม่มีราคาสด ${p.key} ที่เชื่อได้ (${tk ? Math.round(tickAge / 1000) + ' วิ' : 'ไม่มี tick'}) ` +
                    '— ตรวจฝั่งออเดอร์ไม่ได้ ใช้ระดับของ TA แทน',
            );
            return { ...d, size, confidence: conf };
        }
        const mkt = isBuy ? tk.ask : tk.bid;
        {
            const wantBelow = ta.order_type === 'BUY_LIMIT' || ta.order_type === 'SELL_STOP';
            const ok = wantBelow ? entry < mkt : entry > mkt;
            if (!ok) {
                this.logger.warn(
                    `[AI] entry ${entry} ผิดฝั่งของราคาตลาด ${mkt} สำหรับ ${ta.order_type} — ใช้ระดับของ TA แทน`,
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
            reason: moved ? `${ta.reason} | AI ขยับระดับ: ${ai.reason_th}` : `${ta.reason} | AI ยืนยัน`,
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
            analysis_summary_th: reason,
        });

        if (!pr) return no('AI (โหมด lead) ไม่ตอบรอบนี้ — ไม่มีไม้');
        if (pr.action !== 'TRADE') {
            return no(`AI ไม่เจอ setup: ${pr.reason_th || 'ไม่ระบุเหตุผล'}`);
        }
        const { entry, sl, tp1 } = pr;
        if (entry == null || sl == null || tp1 == null) return no('AI เสนอไม้แต่ระดับราคาไม่ครบ');

        const isBuy = pr.order_type.startsWith('BUY');
        if ((isBuy && sl >= entry) || (!isBuy && sl <= entry)) {
            return no(`AI เสนอ ${pr.order_type} แต่ SL อยู่ผิดฝั่งของ entry — ทิ้งไม้`);
        }
        if ((isBuy && tp1 <= entry) || (!isBuy && tp1 >= entry)) {
            return no(`AI เสนอ ${pr.order_type} แต่ TP1 อยู่ผิดฝั่งของ entry — ทิ้งไม้`);
        }

        const risk = Math.abs(entry - sl);
        const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
        if (rr < rrMin) return no(`AI เสนอไม้ R:R ${rr.toFixed(2)} ต่ำกว่าขั้นต่ำ ${rrMin} — ไม่เข้า`);

        // SL ต้องสมเหตุผลเทียบความผันผวนจริง: แคบไปโดนไส้เทียนเขี่ย · กว้างไปเสี่ยงเกินงบ
        const atr = this.execAtr(p, mode, series);
        if (atr && atr > 0) {
            if (risk < atr * 0.3) {
                return no(
                    `AI วาง SL แคบ ${fmtPrice(p, risk)} (< 0.3×ATR ${fmtPrice(p, atr)}) — ไส้เทียนเขี่ยแน่ ทิ้งไม้`,
                );
            }
            if (risk > atr * 3) {
                return no(
                    `AI วาง SL กว้าง ${fmtPrice(p, risk)} (> 3×ATR ${fmtPrice(p, atr)}) — ไม่คุ้มความเสี่ยง ทิ้งไม้`,
                );
            }
        }

        // entry ต้องถูกฝั่งของราคาตลาดตามชนิดออเดอร์ — ราคาของตราสาร p นี้ ไม่ใช่ตัว active
        // ไม่มีราคาสด/ค้าง = ตรวจฝั่งไม่ได้ · ไม้นี้ AI หาเองล้วน (ไม่มี TA ยืนยัน) จึงทิ้งไปเลย
        const tk = this.getLastTick(p);
        const tickAge = tk ? Date.now() - tk.at : Infinity;
        if (!tk || tickAge > STALE_TICK_MS) {
            return no(
                `ไม่มีราคาสด ${p.key} ที่เชื่อได้ (${tk ? Math.round(tickAge / 1000) + ' วิ' : 'ไม่มี tick'}) — ตรวจฝั่งออเดอร์ไม่ได้ ทิ้งไม้`,
            );
        }
        {
            const mkt = isBuy ? tk.ask : tk.bid;
            const wantBelow = pr.order_type === 'BUY_LIMIT' || pr.order_type === 'SELL_STOP';
            if (wantBelow ? entry >= mkt : entry <= mkt) {
                return no(
                    `AI เสนอ ${pr.order_type} ที่ ${fmtPrice(p, entry)} ผิดฝั่งของราคาตลาด ${fmtPrice(p, mkt)} — ทิ้งไม้`,
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
            invalidation: pr.invalidation_th || '',
            playbook_ref: pr.playbook_ref,
            reason: `AI หาไม้เอง (lead): ${pr.reason_th}`,
            analysis_summary_th: [
                `🤖 ไม้นี้มาจาก AI ไม่ใช่ TA (TA ไม่เจอ setup รอบนี้)`,
                `playbook: ${pr.playbook_ref}`,
                pr.key_levels ? `แนวที่ใช้: ${pr.key_levels}` : '',
                pr.risk_note_th ? `ระวัง: ${pr.risk_note_th}` : '',
                pr.news_risk_th ? `ข่าว: ${pr.news_risk_th}` : '',
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
        try {
            const f = this.settingsFile;
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify(Object.fromEntries(this.overrides), null, 2));
        } catch (e) {
            this.logger.error(`บันทึกค่าที่ตั้งไว้ไม่สำเร็จ (${errorMessage(e)}) — ค่าจะหายเมื่อรีสตาร์ท`);
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
            for (const k of ['GOLD_AI_THINKING', 'GEMINI_MODEL']) {
                const v = this.overrides.get(k);
                if (v) this.goldGeminiService.setRuntime(k, v);
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
                    `คืนค่าที่ตั้งไว้จาก ${f} (${this.overrides.size} ค่า)${shown.length ? ' · ' + shown.join(' · ') : ''}`,
                );
            }
        } catch (e) {
            this.logger.error(`อ่านค่าที่ตั้งไว้ไม่สำเร็จ (${errorMessage(e)}) — ใช้ค่าจาก .env แทน`);
        }
    }

    /** อ่าน config โดยเช็ค override จาก dashboard ก่อน แล้วค่อย fallback ไป env */
    private cfg(key: string, fallback: string): string {
        return this.overrides.get(key) ?? this.configService.get<string>(key, fallback);
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
            ai_mode: this.aiMode(), // off | assist | lead
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
    setSettings(body: Record<string, any>) {
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
        const geminiRuntime = new Map<string, string>(); // ค่าที่ต้องยิงข้ามไป goldGeminiService ด้วย
        const logs: string[] = [];
        const applied: string[] = [];
        let leadOn = false;
        let modeChanged = false;

        // ai_assist เป็นสวิตช์ ไม่ใช่ตัวเลข — รับก่อนแล้วค่อยวนค่าที่เหลือ
        if (given(body.ai_assist)) {
            const on = body.ai_assist === true || String(body.ai_assist).toLowerCase() === 'true';
            if (on && !this.goldGeminiService.apiKey) {
                throw new DomainError('เปิด AI assist ไม่ได้: ยังไม่ได้ตั้ง GEMINI_API_KEY ใน env');
            }
            staged.set('GOLD_AI_ASSIST', on ? 'true' : 'false');
            staged.set('GOLD_AI_MODE', on ? 'assist' : 'off');
            applied.push('ai_assist');
            logs.push(`AI assist ${on ? 'เปิด' : 'ปิด'} จาก dashboard`);
        }

        // ai_gate: รอบไหนควรถาม AI (ดู aiGate() ว่าแต่ละค่าหมายถึงอะไร)
        if (given(body.ai_gate)) {
            const g = String(body.ai_gate).toLowerCase();
            if (!['near_miss', 'always', 'setup_only'].includes(g)) {
                throw new DomainError('ai_gate ต้องเป็น near_miss | always | setup_only');
            }
            staged.set('GOLD_AI_GATE', g);
            applied.push(`ai_gate=${g}`);
            logs.push(`AI gate → ${g} จาก dashboard`);
        }

        // ระดับการคิดของ Gemini — ค่าตาม doc: minimal | low | medium | high (3.x รองรับครบ)
        // ต้องยิงเข้า goldGeminiService ด้วย เพราะ service นั้นอ่าน ConfigService คนละก้อนกับ overrides ที่นี่
        if (given(body.ai_thinking)) {
            const lv = String(body.ai_thinking).toLowerCase().trim();
            if (!['minimal', 'low', 'medium', 'high'].includes(lv)) {
                throw new DomainError('ai_thinking ต้องเป็น minimal | low | medium | high');
            }
            staged.set('GOLD_AI_THINKING', lv);
            geminiRuntime.set('GOLD_AI_THINKING', lv);
            applied.push(`ai_thinking=${lv}`);
            logs.push(`ระดับการคิดของ AI → ${lv} จาก dashboard`);
        }

        // รุ่น Gemini — รับเฉพาะชื่อที่ขึ้นต้น gemini- และเป็น 3.x ขึ้นไป (thinking_level รองรับครบ)
        if (given(body.ai_model)) {
            const m = String(body.ai_model).trim();
            const ver = parseFloat(m.replace(/^gemini-/, ''));
            if (!/^gemini-[a-z0-9.-]+$/i.test(m) || !Number.isFinite(ver) || ver < 3) {
                throw new DomainError('ai_model ต้องเป็นรุ่น Gemini 3.x ขึ้นไป เช่น gemini-3.5-flash');
            }
            staged.set('GEMINI_MODEL', m);
            geminiRuntime.set('GEMINI_MODEL', m);
            applied.push(`ai_model=${m}`);
            logs.push(`รุ่น Gemini → ${m} จาก dashboard`);
        }

        // ai_mode: off | assist | lead — สวิตช์ละเอียดกว่า ai_assist (ถ้าส่งมาจะทับ)
        if (given(body.ai_mode)) {
            const m = String(body.ai_mode).toLowerCase();
            if (!['off', 'assist', 'lead'].includes(m)) {
                throw new DomainError('ai_mode ต้องเป็น off | assist | lead');
            }
            if (m !== 'off' && !this.goldGeminiService.apiKey) {
                throw new DomainError(`เปิด AI mode=${m} ไม่ได้: ยังไม่ได้ตั้ง GEMINI_API_KEY ใน env`);
            }
            staged.set('GOLD_AI_MODE', m);
            staged.set('GOLD_AI_ASSIST', m === 'off' ? 'false' : 'true');
            modeChanged = true;
            leadOn = m === 'lead';
            applied.push(`ai_mode=${m}`);
            logs.push(`AI mode → ${m} จาก dashboard`);
        }

        for (const [field, spec] of Object.entries(map)) {
            if (!given(body[field])) continue;
            const v = Number(body[field]);
            if (!isFinite(v) || v < spec.min || v > spec.max) {
                throw new DomainError(`${field} ต้องเป็นตัวเลข ${spec.min}–${spec.max}`);
            }
            staged.set(spec.key, String(v));
            applied.push(`${field}=${v}`);
        }

        // ---- 2) every field passed: apply and persist in one step ----
        if (applied.length) {
            for (const [k, v] of staged) this.overrides.set(k, v);
            for (const [k, v] of geminiRuntime) this.goldGeminiService.setRuntime(k, v);
            if (modeChanged) this.assistKeyWarned = false;
            for (const line of logs) this.logger.log(line);
            if (leadOn) {
                this.activity.push(
                    'warn',
                    '🤖 เปิดโหมด AI lead — เมื่อ TA ไม่เจอ setup AI จะหาไม้เอง (ขนาดไม้ไม่เกินครึ่ง ผ่านด่านความเสี่ยงทุกด่านเหมือนเดิม)',
                );
            }
            // จำลงไฟล์ทันที ไม่งั้นค่าที่เพิ่งตั้งหายตอนรีสตาร์ทแล้วเด้งกลับไปค่า .env ที่หลวมกว่า
            this.persistOverrides();
            this.activity.push('warn', `ตั้งค่าความเสี่ยงใหม่จาก dashboard: ${applied.join(' · ')}`);
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
        if (gate === 'setup_only') return { ask: false, why: 'gate=setup_only — ถาม AI เฉพาะตอน TA เจอ setup' };
        if (gate === 'always') return { ask: true, why: 'gate=always' };
        return d.near_miss
            ? { ask: true, why: `เฉียด (${d.near_miss_rule})` }
            : { ask: false, why: 'ไม่มี setup ตั้งแต่แรก — ถามไปก็เสียโควตาเปล่า' };
    }

    /** รายชื่อรุ่น Gemini ที่เลือกได้จริง + รุ่นที่ใช้อยู่ตอนนี้ */
    async listAiModels() {
        const current = this.goldGeminiService.config.model;
        try {
            return { current, models: await this.goldGeminiService.listModels() };
        } catch (e) {
            this.logger.warn(`ดึงรายชื่อรุ่น Gemini ไม่ได้: ${errorMessage(e)}`);
            return { current, models: [], error: errorMessage(e) };
        }
    }

    /** ปุ่มรีเซ็ตโควตา AI บน dashboard — เริ่มนับใหม่ทันที ไม่ต้องรอข้ามวัน */
    resetAiCalls() {
        const max = parseInt(this.cfg('GOLD_AI_MAX_CALLS_PER_DAY', '10'), 10);
        const before = this.goldGeminiService.resetUsage();
        this.aiQuotaWarnedDay.clear();
        this.activity.push('ok', `🔄 รีเซ็ตโควตา AI แล้ว (เดิมใช้ไป ${before}/${max} ครั้ง) — กลับมาใช้ AI ได้ตามปกติ`);
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
        const before = this.pnlCache?.value ?? null;
        const limit = parseFloat(this.cfg('GOLD_DAILY_MAX_LOSS_USD', '4000'));
        const now = new Date();
        this.dailyStopReset = { day: now.toISOString().slice(0, 10), ts: now.getTime() };
        this.pnlCache = null; // บังคับให้ไปถาม broker ใหม่ ไม่ใช้ค่าที่แคชไว้ก่อนกด
        const beforeTxt = before == null ? 'ยังไม่เคยอ่าน' : `${before.toFixed(2)} USD`;
        this.logger.warn(`เคลียร์ daily stop ด้วยมือ (P&L ก่อนกด ${beforeTxt} · เพดาน -${limit}) — เริ่มนับใหม่จากนี้`);
        this.activity.push(
            'warn',
            `⚠️ เคลียร์ daily stop ด้วยมือ (ขาดทุนก่อนกด ${beforeTxt}) — เริ่มนับใหม่จากตอนนี้ ` +
                `· ด่านยังทำงานต่อ ถ้าขาดทุนใหม่ถึง -${limit} จะหยุดอีก`,
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
                `(modes: ${this.enabledModes().join(', ')} · ตราสาร: ${this.enabledInstruments()
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
            if (!prof) continue; // ไม้ของ symbol ที่ระบบไม่รู้จัก — ไม่แตะ
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
                        `🔒 [${tag}] +1R แล้ว เลื่อน SL กันทุน\nposition ${pid}: SL ${sl} → ${newSl} (entry ${entry})`,
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
            engine: this.configService.get<string>('GOLD_ENGINE', 'ta').toLowerCase(),
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
                        `⏸ ${prof.emoji} ${prof.key}: ${mkt.reason} — พักเฉพาะตราสารนี้ จะกลับมาทำงานต่อเองเมื่อตลาดเปิด`,
                    );
                    this.marketWasOpen.set(prof.key, false);
                }
                waits.push(`${prof.key}: ตลาดปิด`);
                continue;
            }
            if (!wasOpen) {
                this.activity.push(
                    'ok',
                    `▶ ${prof.emoji} ${prof.key}: ${prof.hours.label_th}เปิดแล้ว (${mkt.et_time} ET) — กลับมาทำงานต่ออัตโนมัติ`,
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
                    waits.push(`${tag}: กำลังวิเคราะห์…`);
                    continue;
                }

                if (mode === 'position') {
                    if (this.isPositionDue(now, prof)) this.launch(mode, prof);
                    else waits.push(`${tag}: รอรอบรายวัน`);
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
                        `แท่ง ${cfg.periodMin}m ปิด → เริ่มวิเคราะห์รอบใหม่`,
                        `${prof.key}/${mode}`,
                    );
                    this.launch(mode, prof);
                } else {
                    const leftMs = periodMs - sinceBarOpenMs;
                    waits.push(`${tag}: อีก ${this.fmtWait(leftMs)}`);
                }
            }
        }
        this.heartbeat(now, waits);
    }

    private fmtWait(ms: number): string {
        const s = Math.max(0, Math.round(ms / 1000));
        return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} น.` : `${s} วิ`;
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
                const stale = t && age > STALE_TICK_MS ? ` ⚠ ค้าง ${Math.round(age / 60_000)} นาที` : '';
                return t
                    ? `${p.key} ${fmtPrice(p, t.bid)}/${fmtPrice(p, t.ask)} (spread ${fmtPrice(p, t.ask - t.bid)})${stale}`
                    : `${p.key}: รอราคาสด`;
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
                    ? ` (อีก ${Math.floor(mkt.minutes_to_open / 60)}:${String(mkt.minutes_to_open % 60).padStart(2, '0')} ชม.)`
                    : '';
            this.activity.push('info', `${px} · ${et} ET · ⏸ ${mkt.reason}${left}`);
            return;
        }
        if (!waits) {
            this.activity.push('info', `${px} · ${et} ET · loop ปิดอยู่ (กด Start เพื่อให้บอทเทรดเอง)`);
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
        const st = this.getState(mode, p);
        // ปิดรอบ = ติดป้ายตราสาร/โหมดของรอบนี้เสมอ (ห้ามพึ่ง this.currentMode ที่ใช้ร่วมกัน)
        const finish = (d: GoldDecision | null, outcome: string) => this.finish(st, d, outcome, p, mode);
        st.lastRunAt = new Date().toISOString();
        st.lastError = null;
        let archData: GoldExport | null = null;
        let archResult: { decision: GoldDecision | null; outcome: string } | null = null;
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
                    `skipped: ${p.key} ไม่เปิดโหมด ${mode} — ไม้ต่ำสุด 0.01 lot เสี่ยงเกินงบต่อไม้เมื่อ SL กว้าง ` +
                        `(เปิดได้ที่ env GOLD_MODES_${p.key})`,
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
                    return (archResult = finish(null, `skipped: ครบเพดาน scalp ${maxScalps} ไม้/วันแล้ว`));
                }
            }

            // guard: max concurrent positions on this instrument
            const maxOpen = parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS', '20'), 10);
            const openPositions = await this.getOpenPositions(p, symbolId);
            if (openPositions.count >= maxOpen) {
                return (archResult = finish(
                    null,
                    `skipped: ${p.key} มีภาระค้าง ${openPositions.count} รายการ (ไม้เปิด + ออเดอร์รอ) >= เพดาน ${maxOpen}`,
                ));
            }

            // guard: max concurrent positions รวมทุกตราสาร (เทรดหลายตราสารพร้อมกัน)
            // เพดานต่อตราสารข้างบนกันแต่ละตัวไม่ให้บวมคนเดียว แต่ไม่กันรวมทั้งบัญชี —
            // เปิด XAUUSD 20 + EURUSD 20 + GBPUSD 20 พร้อมกันได้ถ้าไม่มีเพดานนี้
            const maxOpenTotal = parseInt(this.cfg('GOLD_MAX_OPEN_POSITIONS_TOTAL', '0'), 10);
            if (maxOpenTotal > 0) {
                const totalOpen = await this.getOpenPositionsAllInstruments();
                if (totalOpen >= maxOpenTotal) {
                    return (archResult = finish(
                        null,
                        `skipped: รวมทุกตราสารมีภาระค้าง ${totalOpen} รายการ >= เพดานรวม ${maxOpenTotal}`,
                    ));
                }
            }

            // guard: daily loss stop
            const dailyStop = parseFloat(this.cfg('GOLD_DAILY_MAX_LOSS_USD', '4000'));
            if (dailyStop > 0) {
                const pnl = await this.getTodayPnl();
                if (pnl === null) {
                    // เช็ค P&L วันนี้ไม่ได้เลย = คุม daily stop ไม่ได้ -> ห้ามเทรด
                    return (archResult = finish(
                        null,
                        'skipped: เช็ค P&L วันนี้ไม่ได้ (deal list timeout 2 ครั้ง) — ไม่เทรดจนกว่าจะเช็คได้',
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
                const cooldownMs = cooldownBars * cfg.periodMin * 60_000;
                if (lastLossTs && Date.now() - lastLossTs < cooldownMs) {
                    const waitMin = Math.ceil((cooldownMs - (Date.now() - lastLossTs)) / 60_000);
                    return (archResult = finish(
                        null,
                        `skipped: loss cooldown — เพิ่งโดน SL, รออีก ${waitMin} นาที (${cooldownBars} แท่ง ${cfg.periodMin}m)`,
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

            // analysis — GOLD_ENGINE=ta (default): rule-based TA from the pulled
            // indicators (playbook per mode) · =ai: Claude via ANTHROPIC_API_KEY
            const engine = this.configService.get<string>('GOLD_ENGINE', 'ta').toLowerCase();
            let decision: GoldDecision;
            if (engine === 'ai') {
                decision = await this.goldAiService.analyze(
                    data,
                    {
                        rrMin: cfg.rrMin,
                        openPositions: openPositions.summary,
                        sizeCap,
                    },
                    p,
                );
            } else {
                if (!data.series) throw new Error('TA engine requires locally-built series (GOLD_DATA_SOURCE=local)');
                decision = this.goldTaService.analyze(mode, data.series, { rrMin: cfg.rrMin, sizeCap, profile: p });

                // AI assist — ชั้นเสริมบน TA (เปิด/ปิดได้จากหน้า start loop)
                // ปิดอยู่ / ไม่มีคีย์ / AI ล่ม = ใช้ผล TA เดิมต่อ ไม่สะดุด
                // prompt ปรับตามตราสาร+โหมด และแนบข่าวที่กรองตาม keyword ของตราสาร
                let aiMode = this.aiMode();

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
                                `โควตา AI วันนี้เต็ม (${u.used}/${aiMaxCalls}) — สลับเป็น TA ล้วนจนกว่าจะข้ามวันหรือกดรีเซ็ต`,
                            );
                            this.activity.push(
                                'warn',
                                `⚠ โควตา AI เต็ม ${u.used}/${aiMaxCalls} ครั้งวันนี้ — บอทสลับไปใช้ TA ล้วนอัตโนมัติ (ยังเทรดต่อปกติ)`,
                                `${p.key}/${mode}`,
                            );
                        }
                        aiMode = 'off';
                    }
                }

                // โหมด lead: TA ไม่เจอ setup → ให้ AI หาไม้เอง (ไม้ที่ได้ต้องผ่านด่านเข้มกว่า)
                // แต่ไม่ถามทุกรอบ — ผ่านประตู near-miss ก่อน (ดู aiGate())
                const gateCheck =
                    aiMode === 'lead' && decision.order_type === 'NO_TRADE'
                        ? this.shouldAskAiForSetup(decision)
                        : { ask: false, why: '' };
                if (aiMode === 'lead' && decision.order_type === 'NO_TRADE' && !gateCheck.ask) {
                    this.logger.log(`[${mode}] ข้าม AI: ${gateCheck.why}`);
                    st.lastAssist = null;
                } else if (aiMode === 'lead' && decision.order_type === 'NO_TRADE') {
                    const news = await this.newsForAssist(p, p.modes[mode]?.news ?? 15);
                    // โควตาอาจหมดระหว่าง await news (หลายตราสาร x หลายโหมดยิงพร้อมกัน
                    // และ launch() ไม่ await) — ต้องดูผลตอน "หักจริง" ไม่ใช่ตอนเช็คเพดานข้างบน
                    // หักไม่ได้ = ส่ง null ต่อ ซึ่งเป็นทาง "ไม่มี AI" ที่มีอยู่แล้ว (TA ล้วน)
                    const gotQuota = this.goldGeminiService.tryConsume(aiMaxCalls);
                    if (!gotQuota)
                        this.logger.warn(`[${p.key}/${mode}] โควตา AI หมดพอดีตอนจะเรียก — ใช้ TA ล้วนรอบนี้`);
                    const proposal = gotQuota
                        ? await this.goldGeminiService.propose(
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
                            `🤖 AI หาไม้เองได้ (TA ไม่เจอ): ${led.order_type} @ ${fmtPrice(p, led.entry!)} · ${led.playbook_ref}`,
                            `${p.key}/${mode}`,
                        );
                    }
                    decision = led;
                    st.lastAssist = (proposal as any) ?? null;
                } else if (aiMode !== 'off' && decision.order_type !== 'NO_TRADE') {
                    const news = await this.newsForAssist(p, p.modes[mode]?.news ?? 15);
                    // โควตาอาจหมดระหว่าง await news (หลายตราสาร x หลายโหมดยิงพร้อมกัน
                    // และ launch() ไม่ await) — ต้องดูผลตอน "หักจริง" ไม่ใช่ตอนเช็คเพดานข้างบน
                    // หักไม่ได้ = ส่ง null ต่อ ซึ่งเป็นทาง "ไม่มี AI" ที่มีอยู่แล้ว (TA ล้วน)
                    const gotQuota = this.goldGeminiService.tryConsume(aiMaxCalls);
                    if (!gotQuota)
                        this.logger.warn(`[${p.key}/${mode}] โควตา AI หมดพอดีตอนจะเรียก — ใช้ TA ล้วนรอบนี้`);
                    const assist = gotQuota
                        ? await this.goldGeminiService.assist(
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
                            `⚠ AI assist ไม่ตอบรอบนี้ — ใช้ผล TA ล้วน (ดู log หาสาเหตุ: คีย์/timeout/schema)`,
                            `${p.key}/${mode}`,
                        );
                    }
                    decision = this.applyAssist(decision, assist, cfg.rrMin, p);
                    st.lastAssist = assist;
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
            if (dryRun) {
                const id = randomUUID().slice(0, 8);
                this.pending.set(this.sk(mode, p), { id, decision, sizeCap, createdAt: Date.now() });
                return (archResult = finish(decision, `awaiting-approval:${id}`));
            }

            // place the order
            const uuid = await this.placeOrder(mode, decision, sizeCap, p, symbolId);
            await this.notify(mode, decision, `ORDER SENT (${uuid})`, p);
            return (archResult = finish(decision, `order sent: ${uuid}`));
        } catch (e) {
            st.lastError = errorMessage(e);
            this.logger.error(`[${mode}] ${errorMessage(e)}`);
            await this.telegramService.notifyError(`[${p.key} ${mode}] ${errorMessage(e)}`);
            return (archResult = { decision: st.lastDecision, outcome: `error: ${errorMessage(e)}` });
        } finally {
            // เก็บประวัติทุกรอบเป็น .json ใน /archive (วันเวลา UTC + ไทย)
            this.archiveRound(mode, archData, archResult, p);
        }
    }

    /** ข่าวสำหรับ AI assist — ล้มเหลว/ช้า = ส่งลิสต์ว่าง ไม่ทำให้รอบสะดุด */
    private async newsForAssist(p: InstrumentProfile, limit: number): Promise<any[]> {
        try {
            const timeout = new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 12_000));
            const items = await Promise.race([this.goldBuilderService.fetchNews(limit, p), timeout]);
            return Array.isArray(items) ? items : [];
        } catch (e) {
            this.logger.warn(`news for AI assist failed (${errorMessage(e)}) — ส่ง prompt โดยไม่มีข่าว`);
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

        const uuid = await this.placeOrder(mode, p.decision, p.sizeCap, prof, symbolId);
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
                engine: this.configService.get<string>('GOLD_ENGINE', 'ta'),
                ai_assist: this.aiAssistEnabled(),
                outcome: result?.outcome ?? 'unknown',
                decision: result?.decision ?? null,
                data_errors: data?.errors ?? null,
                series_meta: seriesMeta,
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
        const withNews = this.configService.get<string>('GOLD_ENGINE', 'ta').toLowerCase() === 'ai';
        if (source === 'remote') {
            // ZIP จาก z-service มีแต่ชุดทอง — ตราสารอื่นต้องสร้างข้อมูลในตัวเท่านั้น
            if (p.key !== 'XAUUSD')
                throw new Error(`GOLD_DATA_SOURCE=remote รองรับเฉพาะ XAUUSD — ${p.key} ต้องใช้ local`);
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
            return 'Friday บ่าย ET — งดไม้ใหม่ก่อนปิดสัปดาห์';
        }
        if (mode === 'scalp') {
            const inWindow = p.session.scalpWindows.some(([a, b]) => min >= a && min < b);
            if (!inWindow) {
                return `นอกหน้าต่าง scalp (${p.session.scalpWindows.map(([a, b]) => `${hhmm(a)}-${hhmm(b)} ET`).join(' / ')})`;
            }
        }
        if (mode === 'intraday') {
            const [a, b] = p.session.intradayWindow;
            if (!(min >= a && min < b)) return `นอกหน้าต่าง intraday (${hhmm(a)}–${hhmm(b)} ET)`;
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
                parts.push(`(รอ) ${side} ${lotsOf(o.tradeData)} lots @ ${px}`);
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
     * P&L ของวันนี้ (UTC day) — retry 2 ครั้งก่อนยอมแพ้ เพราะ ProtoOADealListReq
     * ช้าเป็นพัก ๆ (14 ส.ค. 2569: timeout 7 รอบ = รอบตายฟรีทั้งที่ยังไม่วิเคราะห์)
     * ล้มทั้งสองครั้ง -> ใช้ค่าที่แคชไว้ถ้ายังสด, ไม่งั้นคืน null = เช็คไม่ได้
     * (ผู้เรียกต้อง fail-closed: ไม่รู้ P&L = ห้ามเทรด เพราะ daily stop คุมไม่ได้)
     */
    private async getTodayPnl(): Promise<number | null> {
        const now = new Date();
        const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        // กด "เคลียร์ daily stop" = ขยับจุดเริ่มนับมาที่เวลาที่กด · ไม้ที่ปิดก่อนหน้านั้นไม่นับอีก
        // แต่ไม้ที่ปิด "หลัง" จุดนั้นยังนับปกติ = ด่านยังทำงานต่อ ตัดซ้ำได้ถ้าขาดทุนใหม่ถึงเพดาน
        const reset = this.activeDailyStopReset();
        const from = reset ? Math.max(midnight, reset.ts) : midnight;
        const timeouts = [20_000, 30_000];

        for (let attempt = 0; attempt < timeouts.length; attempt++) {
            try {
                const dealsRes = await this.ctraderService.getDealList(from, now.getTime(), timeouts[attempt]);
                let pnl = 0;
                for (const deal of (dealsRes?.deal ?? []) as any[]) {
                    const d = deal.closePositionDetail;
                    if (!d) continue;
                    const divisor = Math.pow(10, deal.moneyDigits || 2);
                    const val = (v: any) => (typeof v === 'number' ? v : (v?.low ?? 0));
                    pnl += (val(d.grossProfit) + val(d.commission) + val(d.swap)) / divisor;
                }
                this.pnlCache = { value: pnl, ts: Date.now() };
                return pnl;
            } catch (e) {
                const last = attempt === timeouts.length - 1;
                this.logger.warn(
                    `getTodayPnl attempt ${attempt + 1}/${timeouts.length} failed: ${errorMessage(e)}${last ? '' : ' — retrying'}`,
                );
                if (!last) await new Promise((r) => setTimeout(r, 2_000));
            }
        }

        // fallback: ค่าล่าสุดที่ดึงสำเร็จ ถ้าไม่เกิน 10 นาที (ไม้ปิดใหม่ในช่วงนั้นยัง
        // ถูกจับได้จาก loss cooldown อีกชั้น) — เกินนั้นถือว่าเช็คไม่ได้
        if (this.pnlCache && Date.now() - this.pnlCache.ts < PNL_CACHE_TTL_MS) {
            const ageMin = Math.round((Date.now() - this.pnlCache.ts) / 60_000);
            this.logger.warn(
                `getTodayPnl: ใช้ค่าที่แคชไว้ ${this.pnlCache.value.toFixed(2)} USD (เก่า ${ageMin} นาที)`,
            );
            this.activity.push(
                'warn',
                `deal list ช้า — ใช้ P&L ที่แคชไว้ ${this.pnlCache.value.toFixed(2)} USD (เก่า ${ageMin} นาที)`,
                this.currentMode,
            );
            return this.pnlCache.value;
        }
        return null;
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
        if (!data.series) return null; // remote ZIP path — ไม่มี series ให้ตรวจ
        const required = p.modes[mode].sets.filter((s) => s.symbol === p.key);
        const staleMult = parseFloat(this.configService.get<string>('GOLD_MAX_BAR_AGE_MULT', '3'));

        for (const { tf, nBars } of required) {
            const key = seriesKey(p, tf);
            const bars = data.series[key];
            if (!bars?.length) {
                return `ข้อมูล ${p.key} ${tf} ดึงไม่ได้ — ห้ามเทรดรอบนี้ (${data.errors ?? 'ไม่ทราบสาเหตุ'})`;
            }
            const minBars = Math.min(60, nBars);
            if (bars.length < minBars) {
                return `${p.key} ${tf} ได้แค่ ${bars.length}/${minBars} แท่ง — ข้อมูลไม่พอวิเคราะห์`;
            }
            const ageMs = Date.now() - bars[bars.length - 1].ts;
            // TF รายวัน/รายสัปดาห์: ต้องเผื่อช่วงที่ตลาดปิด ไม่งั้นเช้าวันจันทร์
            // แท่ง 1d ล่าสุดคือของวันศุกร์ = เก่า ~2.6 วัน ชน 3×TF พอดี → swing/position
            // ถูกบล็อกทิ้งทั้งวันจันทร์ทุกสัปดาห์ (นับเวลาที่ตลาดไม่เปิดเป็น "ข้อมูลค้าง")
            const weekendAllowance = tf === '1d' || tf === '1w' ? 2 * 86_400_000 : 0;
            const maxAge = INTERVAL_MS[tf] * staleMult + weekendAllowance;
            if (ageMs > maxAge) {
                const mins = Math.round(ageMs / 60_000);
                return `แท่งล่าสุดของ ${p.key} ${tf} เก่า ${mins} นาที (เกิน ${staleMult}×TF) — ข้อมูลค้าง/ตลาดปิด ห้ามเทรด`;
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
            return `SL กว้าง ${fmtPrice(p, Math.abs(d.entry - d.sl))} → เสี่ยงจริง $${actualRisk.toFixed(0)} ที่ ${lots} lot เกินงบ $${riskUsd} (min lot 0.01 ก็ยังเกิน)`;
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
        const factor: Record<GoldSize, number> = { full: 1, half: 0.5, quarter: 0.25 };
        const capOrder: Record<GoldSize, number> = { quarter: 1, half: 2, full: 3 };
        const effective: GoldSize = cap && capOrder[cap] < capOrder[size] ? cap : size;
        const maxLot = this.maxLotFor(p);
        const sizing = this.cfg('GOLD_SIZING', 'risk').toLowerCase();

        let lots: number;
        const slDist = entry != null && sl != null ? Math.abs(entry - sl) : 0;
        if (sizing === 'risk' && slDist > 0) {
            // fixed-risk sizing (consensus best practice): ทุกไม้เสี่ยง $ เท่ากัน
            // ไม่ว่า SL กว้างแค่ไหน — post-mortem เดิม: fixed lots ทำให้ไม้ position
            // (SL 314$) เสี่ยงเงินมากกว่าไม้ intraday (SL 17$) ถึง ~18 เท่า
            // XAUUSD: 1 lot = 100 oz → $1 move = $100/lot · FX: 1 lot = 100k → 1 pip = $10 (USD-quoted)
            const riskUsd = parseFloat(this.cfg('GOLD_RISK_USD_PER_TRADE', '1500'));
            lots = (riskUsd * factor[effective]) / (slDist * usdPerUnitMovePerLot(p, entry!));
        } else {
            const base = parseFloat(this.cfg('GOLD_BASE_LOT', '0.1'));
            lots = base * factor[effective];
        }
        return Math.min(maxLot, Math.max(0.01, Math.round(lots * 100) / 100));
    }

    /** most recent losing close on this instrument within 24h (for the loss cooldown) */
    private async getLastLossCloseTs(symbolId: number): Promise<number | null> {
        try {
            const now = Date.now();
            const res = await this.ctraderService.getDealList(now - 24 * 3_600_000, now);
            const num = (v: any) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));
            let last: number | null = null;
            for (const deal of (res?.deal ?? []) as any[]) {
                const det = deal.closePositionDetail;
                if (!det) continue;
                if (num(deal.symbolId) !== symbolId) continue;
                const divisor = Math.pow(10, num(deal.moneyDigits) || 2);
                const net = (num(det.grossProfit) + num(det.commission) + num(det.swap)) / divisor;
                const ts = num(deal.executionTimestamp);
                if (net < 0 && (!last || ts > last)) last = ts;
            }
            return last;
        } catch (e) {
            this.logger.warn(`getLastLossCloseTs failed: ${errorMessage(e)}`);
            return null;
        }
    }

    private async placeOrder(
        mode: GoldMode,
        d: GoldDecision,
        sizeCap: GoldSize | null,
        p: InstrumentProfile,
        symbolId: number,
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
        const volume = this.resolveVolume(d.size, sizeCap, d.entry, d.sl, p);

        if (mode === 'scalp') {
            const n = this.scalpsToday(p);
            this.scalpCount.set(p.key, { day: new Date().toISOString().slice(0, 10), count: n + 1 });
        }

        const orderParams: any = {
            uuid,
            symbol: p.symbolName,
            symbolId, // ExecutionService ใช้ตัวนี้ได้เลย ไม่ต้องค้นชื่อซ้ำ
            unitsPerLot: p.unitsPerLot, // ทอง 100 oz · FX 100,000
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
            engine: this.configService.get<string>('GOLD_ENGINE', 'ta'),
            reason: d.reason,
            playbookRef: d.playbook_ref,
            invalidation: d.invalidation,
            tp2: d.tp2 ?? undefined,
            rrTp1: d.rr_tp1 ?? undefined,
            confidence: d.confidence,
            analysisSummary: d.analysis_summary_th,
        });

        await this.executionService.executeOrder(orderParams);
        return uuid;
    }

    private async notify(mode: GoldMode, d: GoldDecision, headline: string, p: InstrumentProfile = this.profile) {
        const lines = [
            `${p.emoji} <b>[${p.key} ${mode.toUpperCase()}] ${headline}</b>`,
            d.order_type !== 'NO_TRADE'
                ? `${d.order_type} @ ${d.entry} | SL ${d.sl} | TP1 ${d.tp1}${d.tp2 ? ` | TP2 ${d.tp2}` : ''} | R:R ${d.rr_tp1} | conf ${d.confidence}/10 | size ${d.size}`
                : // reason/invalidation/analysis_summary_th อุ้มข้อความอิสระจาก AI มาด้วย
                  // (applyAssist/applyProposal ยัด ai.reason_th, pr.invalidation_th ฯลฯ ลงไป)
                  // ไม่ escape = ตัว < > & ตัวเดียวทำให้ Telegram ทิ้งทั้งข้อความ
                  // = ออเดอร์ยิงจริงแต่ไม่มีใครรู้ (บั๊กเดียวกับที่เคยแก้ไปแล้วรอบหนึ่ง)
                  `เหตุผล: ${this.esc(d.reason)}`,
            d.invalidation ? `❌ Invalidation: ${this.esc(d.invalidation)}` : '',
            ...this.assistLines(d),
            d.valid_until_utc ? `⏳ valid until ${this.esc(d.valid_until_utc)}` : '',
            '',
            this.esc(d.analysis_summary_th),
        ].filter(Boolean);
        await this.telegramService.notifyOrderSuccess(lines.join('\n'));
    }
}
