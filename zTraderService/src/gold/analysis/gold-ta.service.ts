import { Injectable, Logger } from '@nestjs/common';
import { GoldDecision, GoldOrderType, GoldSize } from '../ai/gold-ai.service';
import { GoldMode } from '../data/gold-data.service';
import { EnrichedBar } from '../domain/indicators';
import { INTERVAL_MS } from '../domain/gold-modes';
import { InstrumentProfile, XAUUSD_PROFILE, fmtPrice, roundPrice, seriesKey } from '../domain/instruments';
import { errorMessage } from '../../common/utils/errors';

/**
 * Rule-based TA engine — implements the mode playbooks from gold.py/XAU_AUTOMATE
 * directly on the enriched bars (no AI call):
 *   scalp    : liquidity sweep + Asian-range break-retest on 5m (15m = context)
 *   intraday : Asian range break (STOP) / retest (LIMIT), 1h = direction TF
 *   swing    : 4H EMA50/200 trend filter + pullback to EMA20/50-Fib zone (LIMIT)
 *   position : 1W close vs EMA20W + deep daily pullback (Fib 50-61.8) (LIMIT)
 * Companions (DXY/US10Y/VIX/USDJPY/SPY/WTI/BTC/XAG/GDX) adjust confidence and
 * can veto. Order semantics: LIMIT = wait pullback, STOP = wait breakout.
 *
 * รองรับหลายตราสารผ่าน InstrumentProfile (ctx.p): ชื่อ series, เลขกลม (step/buffer),
 * เป้า scalp, ทศนิยม, ตัวประกอบ และ lead indicator มาจากโปรไฟล์ทั้งหมด —
 * โปรไฟล์ XAUUSD ให้ค่าเดิมเป๊ะ ผลลัพธ์ของทองต้องไม่เปลี่ยน (มี regression test คุม)
 */

interface Pivot {
    i: number;
    price: number;
    ts: number;
}
interface Leg {
    lo: Pivot;
    hi: Pivot;
    up: boolean;
}

interface Ctx {
    mode: GoldMode;
    rrMin: number;
    p: InstrumentProfile; // โปรไฟล์ตราสารที่วิเคราะห์ (default XAUUSD)
    sym: string; // key ตัวพิมพ์เล็กของ series เช่น 'xauusd'
    series: Record<string, EnrichedBar[]>;
    notes: string[]; // running Thai commentary for the summary
    compScore: number; // -3..+3 (positive = supports longs on the instrument)
    compNotes: string[];
}

/* ════════════════════════════════════════════════════════════════════════
 * 🎛️  ตารางกฎ "รอบนี้เฉียดไหม" — แก้ที่นี่ที่เดียว
 * ════════════════════════════════════════════════════════════════════════
 *
 * ใช้ตัดสินว่ารอบที่ TA ตอบ NO_TRADE ควรส่งต่อให้ AI หาไม้ไหม (โหมด lead)
 *
 * แนวคิด: แยก NO_TRADE ออกเป็น 2 พวก
 *   🟡 เฉียด      = โครงสร้างมีอยู่จริง แต่ตกเกณฑ์ "เชิงปริมาณ" ข้อเดียว
 *                   (RVOL ต่ำนิดเดียว · R:R ขาดนิดเดียว · SL กว้างไปหน่อย · รอแท่งยืนยัน)
 *                   → มีอะไรให้ AI ตัดสินจริง คุ้มค่าถาม
 *   ⚪ ไม่มีอะไร  = ไม่มี setup ตั้งแต่แรก
 *                   → ถามไปก็ได้ NO_TRADE กลับมา เสียเงินเปล่า
 *
 * วัดจาก archive จริง 2,412 รอบ (10 วันเทรด):
 *   ทุกรอบ NO_TRADE = 68 ครั้ง/วัน  ·  เฉพาะรอบเฉียด = 24 ครั้ง/วัน  (ประหยัด 65%)
 *   และ 361 รอบที่ตัดออกคือรอบที่ "ไม่มี setup เลย" ล้วน ๆ
 *
 * ตรงกับแนวทางที่งานวิจัยใช้ (LLM-Gated FinRL: "Critical Decision Detector"
 * เปิดประตูให้ LLM เฉพาะตอนตัวชี้วัดขัดแย้งกัน ไม่ใช่ทุกรอบ)
 *
 * ── วิธีแก้ ──────────────────────────────────────────────────────────
 *   อยากให้ AI เห็นเคสใหม่   → เพิ่มแถวใน NEAR_MISS_RULES
 *   อยากเลิกถาม AI เคสไหน    → ลบแถว หรือใส่ enabled: false
 *   อยากรู้ว่ากฎไหนคุ้ม       → ดู near_miss_rule ใน archive แล้วเทียบผลไม้
 *   เปลี่ยนนโยบายทั้งระบบ     → ใช้ GOLD_AI_GATE (near_miss | always | setup_only)
 *                              ไม่ต้องแตะไฟล์นี้เลย
 * ─────────────────────────────────────────────────────────────────────
 */
export interface NearMissRule {
    id: string;
    /** อธิบายว่าทำไมเคสนี้คุ้มค่าถาม AI */
    why_th: string;
    /** จับจากข้อความเหตุผลที่ TA เขียน */
    match: RegExp;
    /** ปิดชั่วคราวได้โดยไม่ต้องลบแถว */
    enabled?: boolean;
}

export const NEAR_MISS_RULES: NearMissRule[] = [
    {
        id: 'await-confirm-bar',
        why_th: 'ราคาทะลุกรอบแล้วแต่แท่งยังไม่ปิด — TA รอยืนยันตามวินัย แต่โครงสร้างอาจชัดพอแล้ว (เจอบ่อยสุด 140 รอบ)',
        match: /ยังไม่มีแท่ง .* ปิดนอกกรอบ|รอ break ที่ยืนยันด้วยแท่งปิด/,
    },
    {
        id: 'sl-slightly-wide',
        why_th: 'SL ตามโครงสร้างกว้างเกินเพดาน ATR นิดเดียว — AI อาจหาจุดวาง SL ที่แคบกว่าโดยยังเกาะโครงสร้าง (43 รอบ)',
        match: /SL โครงสร้างกว้าง [\d.]+×ATR/,
    },
    {
        id: 'await-reversal-bar',
        why_th: 'ราคาอยู่ในโซน pullback แล้วแต่ยังไม่มีแท่งกลับตัว — จังหวะที่ AI อ่านบริบทได้ดีกว่ากฎแข็ง (14 รอบ)',
        match: /อยู่ในโซน pullback แต่ยังไม่มีแท่งกลับตัว/,
    },
    {
        id: 'tf-regime-conflict',
        why_th: 'TF ขัดกันเอง (4H ขึ้น แต่ใต้ EMA200 รายวัน) — งานวิจัยชี้ว่า "indicator disagreement" คือจังหวะที่ LLM มีประโยชน์สุด (12 รอบ)',
        match: /ขัดกับ regime 1d|ทิศ 1H ขัด/,
    },
    {
        id: 'rr-just-below',
        why_th: 'R:R ขาดไปนิดเดียวหลังหลบเลขกลม — AI อาจหา TP ที่สมจริงกว่าโดยไม่ทับแม่เหล็กราคา (15 รอบ)',
        match: /R:R [\d.]+ < เกณฑ์|ให้ R:R [\d.]+ </,
    },
    {
        id: 'rvol-just-below',
        why_th: 'RVOL ต่ำกว่าเกณฑ์แค่ปัดเศษ (เจอจริง 0.99 / 1.04 / 1.08 / 1.18 เทียบเกณฑ์ 1.2) — เส้นแบ่งแข็งเกินไป (11 รอบ)',
        match: /RVOL [\d.]+ < [\d.]+/,
    },
    {
        id: 'past-zone',
        why_th: 'ราคาเลยโซน pullback ไปแล้วแต่ยังไม่ไกลมาก — AI อาจเห็น leg ใหม่ที่กฎยังไม่รับรู้',
        match: /ราคาเลยโซน pullback ไปแล้ว/,
    },
];

/**
 * จัดประเภท NO_TRADE — ใช้ทั้งใน TA และเวลาวิเคราะห์สถิติย้อนหลัง
 * export ไว้ให้เทสต์และสคริปต์วิเคราะห์เรียกได้โดยไม่ต้องยก service ทั้งตัว
 */
export function classifyNoTrade(reason: string): { near_miss: boolean; near_miss_rule: string | null } {
    for (const r of NEAR_MISS_RULES) {
        if (r.enabled === false) continue;
        if (r.match.test(reason)) return { near_miss: true, near_miss_rule: r.id };
    }
    return { near_miss: false, near_miss_rule: null };
}

@Injectable()
export class GoldTaService {
    private readonly logger = new Logger(GoldTaService.name);

    analyze(
        mode: GoldMode,
        series: Record<string, EnrichedBar[]>,
        opts: { rrMin: number; sizeCap: GoldSize | null; profile?: InstrumentProfile },
    ): GoldDecision {
        const p = opts.profile ?? XAUUSD_PROFILE;
        const ctx: Ctx = {
            mode,
            rrMin: opts.rrMin,
            p,
            sym: p.key.toLowerCase(),
            series,
            notes: [],
            compScore: 0,
            compNotes: [],
        };
        this.scoreCompanions(ctx);

        let d: GoldDecision;
        try {
            switch (mode) {
                case 'scalp':
                    d = this.analyzeScalp(ctx);
                    break;
                case 'intraday':
                    d = this.analyzeIntraday(ctx);
                    break;
                case 'swing':
                    d = this.analyzeSwing(ctx);
                    break;
                case 'position':
                    d = this.analyzePosition(ctx);
                    break;
                default:
                    d = this.noTrade(`unknown mode ${String(mode)}`);
            }
        } catch (e) {
            this.logger.error(`[${mode}] TA error: ${errorMessage(e)}`);
            return this.noTrade(`TA error: ${errorMessage(e)}`);
        }

        // companion veto / adjustment on any trade decision
        if (d.order_type !== 'NO_TRADE') {
            const dir = d.order_type.startsWith('BUY') ? 1 : -1;
            const aligned = ctx.compScore * dir;
            if (aligned <= -2) {
                return this.noTrade(
                    `setup ${d.playbook_ref} ผ่าน แต่ตัวประกอบขัดแรง (score ${ctx.compScore}): ${ctx.compNotes.join(' · ')}`,
                );
            }
            if (aligned >= 1) d.confidence = Math.min(10, d.confidence + 1);
            if (aligned <= -1) {
                d.confidence = Math.max(0, d.confidence - 1);
                d.size = 'half';
            }
            if (opts.sizeCap === 'half' && d.size === 'full') d.size = 'half';
            if (opts.sizeCap === 'quarter') d.size = 'quarter';
            d.analysis_summary_th = this.summary(ctx, d);
        }
        return d;
    }

    // ================= mode: SWING =================

    private analyzeSwing(ctx: Ctx): GoldDecision {
        const h4 = this.closed(ctx, seriesKey(ctx.p, '4h'));
        const d1 = this.closed(ctx, seriesKey(ctx.p, '1d'));
        const h1 = this.closed(ctx, seriesKey(ctx.p, '1h'));
        if (h4.length < 220 || d1.length < 30 || h1.length < 30) return this.noTrade('ข้อมูล 4h/1d/1h ไม่พอ');

        const L4 = h4[h4.length - 1];
        const LD = d1[d1.length - 1];
        const price = this.livePrice(ctx, [seriesKey(ctx.p, '1h'), seriesKey(ctx.p, '4h')]);
        const atrD = LD.atr14;
        if (!this.ema200Ready(h4) || !this.ema200Ready(d1)) {
            return this.noTrade(
                `ข้อมูลไม่พอให้ EMA200 อุ่นตัว (4h ${h4.length} แท่ง · 1d ${d1.length} แท่ง ต้อง >= 250) ` +
                    '— ทิศ/regime เชื่อไม่ได้ ไม่เทรดรอบนี้',
            );
        }
        const bull = L4.ema50 > L4.ema200;
        const dir = bull ? 1 : -1;
        ctx.notes.push(
            `4H trend: EMA50 ${this.f(ctx, L4.ema50)} ${bull ? '>' : '<'} EMA200 ${this.f(ctx, L4.ema200)} → ${bull ? 'ขาขึ้น เล่นฝั่ง BUY' : 'ขาลง เล่นฝั่ง SELL'} (playbook swing #1)`,
        );

        // regime filter (research: 200-day MA เป็น regime filter ที่มีหลักฐานแน่นสุด
        // สำหรับ pullback trading) — 4H trend ต้องไม่ขัดกับฝั่งของราคาเทียบ EMA200(1d)
        const regimeBull = LD.close > LD.ema200;
        if (regimeBull !== bull) {
            return this.noTrade(
                `ทิศ 4H (${bull ? 'ขึ้น' : 'ลง'}) ขัดกับ regime 1d (ราคา${regimeBull ? 'เหนือ' : 'ใต้'} EMA200(1d) ${this.f(ctx, LD.ema200)}) — ช่วงเปลี่ยนผ่าน ไม่เทรด`,
            );
        }

        // last impulse leg on 4H in trend direction
        const leg = this.lastLeg(h4, bull, 4);
        if (!leg) return this.noTrade(`ไม่พบ swing leg ทิศ${bull ? 'ขึ้น' : 'ลง'}บน 4H ที่ชัดพอ — รอโครงสร้าง`);
        const legLo = leg.lo.price,
            legHi = leg.hi.price;
        const fib = (r: number) => (bull ? legHi - (legHi - legLo) * r : legLo + (legHi - legLo) * r);
        ctx.notes.push(
            `Leg 4H: ${this.f(ctx, legLo)} → ${this.f(ctx, legHi)} | Fib38.2 ${this.f(ctx, fib(0.382))} · 50 ${this.f(ctx, fib(0.5))} · 61.8 ${this.f(ctx, fib(0.618))}`,
        );

        // pullback zone: EMA20/50(4H) + Fib50 — entry = the zone anchor on trend side
        const zoneA = bull ? Math.min(L4.ema20, fib(0.382)) : Math.max(L4.ema20, fib(0.382));
        const entryLimit = this.avoidRound(ctx, (zoneA + fib(0.5)) / 2, -dir); // between shallow anchor and fib50

        const distToZone = dir * (price - entryLimit);
        const confirm = this.reversalConfirmation(h1, bull) || this.reversalConfirmation(h4, bull);

        let orderType: GoldOrderType;
        let entry: number;
        let playbook = 'swing #1';
        let sizeBase: GoldSize = 'full';

        if (distToZone > 0.15 * atrD) {
            // price above (bull) / below (bear) the zone — wait for the pullback
            orderType = bull ? 'BUY_LIMIT' : 'SELL_LIMIT';
            entry = entryLimit;
            if (!confirm) {
                sizeBase = 'half';
                playbook = 'swing #2';
                ctx.notes.push('ยังไม่มีแท่งยืนยัน → ตั้ง LIMIT ที่โซนขนาดครึ่งไม้ (playbook swing #2)');
            }
        } else if (distToZone > -0.6 * atrD) {
            // already inside the zone — need confirmation, enter on break of confirm bar
            if (!confirm) return this.noTrade('ราคาอยู่ในโซน pullback แต่ยังไม่มีแท่งกลับตัวยืนยัน (swing #2) — รอ');
            const c = h1[h1.length - 1];
            orderType = bull ? 'BUY_STOP' : 'SELL_STOP';
            entry = this.avoidRound(ctx, bull ? c.high + 0.1 * c.atr14 : c.low - 0.1 * c.atr14, dir);
            playbook = 'swing #2';
            ctx.notes.push(`มีแท่งยืนยัน (${confirm}) ในโซน → ${orderType} เหนือ/ใต้แท่งยืนยัน`);
        } else {
            return this.noTrade(
                `ราคาเลยโซน pullback ไปแล้ว ${this.f(ctx, Math.abs(distToZone))} (${(Math.abs(distToZone) / atrD).toFixed(1)}×ATR) — โครงสร้างเสีย รอ leg ใหม่`,
            );
        }

        // SL: beyond pullback structure, sanity 0.6–1.8 × ATR(1d)
        const structSl = bull
            ? Math.min(fib(0.786), this.recentExtreme(h1, 24, 'low')) - 0.25 * atrD
            : Math.max(fib(0.786), this.recentExtreme(h1, 24, 'high')) + 0.25 * atrD;
        let sl = this.avoidRound(ctx, structSl, -dir);
        let risk = dir * (entry - sl);
        if (risk < 0.6 * atrD) {
            sl = entry - dir * atrD;
            risk = atrD;
            ctx.notes.push('SL โครงสร้างแคบไป → ขยายเป็น 1.0×ATR(1d)');
        }
        if (risk > 1.8 * atrD)
            return this.noTrade(
                `SL โครงสร้างกว้าง ${(risk / atrD).toFixed(1)}×ATR(1d) เกินเกณฑ์ 1.5 — ไม้นี้ risk ไม่คุ้ม`,
            );

        return this.buildLevels(ctx, {
            orderType,
            entry,
            sl,
            dir,
            playbook,
            sizeBase,
            magnets: [legHi, legLo],
            validHours: 24,
            confBase:
                5 +
                (this.emaTrendAligned(d1, bull) ? 1 : 0) +
                (confirm ? 1 : 0) +
                (this.rsiInPullbackZone(h1, bull) ? 1 : 0),
        });
    }

    // ================= mode: POSITION =================

    private analyzePosition(ctx: Ctx): GoldDecision {
        const w1 = this.closed(ctx, seriesKey(ctx.p, '1w'));
        const d1 = this.closed(ctx, seriesKey(ctx.p, '1d'));
        if (w1.length < 30 || d1.length < 30) return this.noTrade('ข้อมูล 1w/1d ไม่พอ');

        const LW = w1[w1.length - 1];
        const price = this.livePrice(ctx, [seriesKey(ctx.p, '1d'), seriesKey(ctx.p, '1w')]);
        const bull = LW.close > LW.ema20;
        const dir = bull ? 1 : -1;
        const atrW = LW.atr14;
        ctx.notes.push(
            `1W close ${this.f(ctx, LW.close)} ${bull ? '>' : '<'} EMA20W ${this.f(ctx, LW.ema20)} → ระบอบ${bull ? 'ขาขึ้น' : 'ขาลง'} (playbook position #1)`,
        );

        const leg = this.lastLeg(w1, bull, 2);
        if (!leg) return this.noTrade('ไม่พบ leg รายสัปดาห์ที่ชัด — รอโครงสร้าง');
        const fib = (r: number) =>
            bull ? leg.hi.price - (leg.hi.price - leg.lo.price) * r : leg.lo.price + (leg.hi.price - leg.lo.price) * r;

        // first tranche at Fib50 of the weekly leg (position #2)
        const entry = this.avoidRound(ctx, fib(0.5), -dir);
        if (dir * (price - entry) <= 0.2 * atrW) {
            // already deep in / beyond the zone: need daily reversal confirmation
            const confirm = this.reversalConfirmation(d1, bull);
            if (!confirm)
                return this.noTrade(
                    'ราคาอยู่ใน/เลยโซน Fib50 รายสัปดาห์ แต่ยังไม่มีแท่งกลับตัวรายวัน (position #2) — รอ',
                );
            const c = d1[d1.length - 1];
            const e2 = this.avoidRound(ctx, bull ? c.high + 0.1 * c.atr14 : c.low - 0.1 * c.atr14, dir);
            const sl = this.avoidRound(ctx, bull ? leg.lo.price - 0.2 * atrW : leg.hi.price + 0.2 * atrW, -dir);
            return this.buildLevels(ctx, {
                orderType: bull ? 'BUY_STOP' : 'SELL_STOP',
                entry: e2,
                sl,
                dir,
                playbook: 'position #2',
                sizeBase: 'half',
                magnets: [leg.hi.price, leg.lo.price],
                validHours: 120,
                confBase: 5 + 1 + (this.emaTrendAligned(d1, bull) ? 1 : 0),
            });
        }

        let sl = this.avoidRound(
            ctx,
            bull
                ? Math.min(leg.lo.price, entry - atrW) - 0.2 * atrW
                : Math.max(leg.hi.price, entry + atrW) + 0.2 * atrW,
            -dir,
        );
        const risk = dir * (entry - sl);
        if (risk > 1.6 * atrW) sl = entry - dir * 1.3 * atrW;

        return this.buildLevels(ctx, {
            orderType: bull ? 'BUY_LIMIT' : 'SELL_LIMIT',
            entry,
            sl,
            dir,
            playbook: 'position #2',
            sizeBase: 'half', // ทยอยไม้ตาม playbook #2 — ไม้แรกครึ่งเดียว
            magnets: [leg.hi.price, leg.lo.price],
            validHours: 120,
            confBase: 5 + (this.emaTrendAligned(d1, bull) ? 1 : 0) + (this.leadConfirms(ctx, bull) ? 1 : 0),
        });
    }

    // ================= mode: INTRADAY =================

    private analyzeIntraday(ctx: Ctx): GoldDecision {
        const m15 = this.closed(ctx, seriesKey(ctx.p, '15m'));
        const h1 = this.closed(ctx, seriesKey(ctx.p, '1h'));
        if (m15.length < 60 || h1.length < 60) return this.noTrade('ข้อมูล 15m/1h ไม่พอ');

        const now = Date.now();
        const range = this.asianRange(m15, now);
        if (!range) return this.noTrade('กรอบเอเชียวันนี้ยังไม่ครบ (ก่อน 14:00 ไทย) — รอ London (intraday #1)');
        const { hi: rH, lo: rL } = range;
        const width = rH - rL;
        const L1 = h1[h1.length - 1];
        const atrH = L1.atr14;
        const price = this.livePrice(ctx, [seriesKey(ctx.p, '15m'), seriesKey(ctx.p, '1h')]);
        ctx.notes.push(
            `Asian range ${this.f(ctx, rL)}–${this.f(ctx, rH)} (กว้าง ${this.f(ctx, width)}) · 1H EMA20 ${this.f(ctx, L1.ema20)} vs EMA50 ${this.f(ctx, L1.ema50)}`,
        );

        if (width < 0.5 * atrH)
            return this.noTrade(`กรอบเอเชียแคบผิดปกติ (${this.f(ctx, width)} < 0.5×ATR1h) — breakout เชื่อไม่ได้`);
        const bull = L1.ema20 > L1.ema50;

        // SL: post-mortem 2026-08-04 โดนกวาดที่ 1.2×ATR — งานอ้างอิงส่วนใหญ่ให้วาง
        // ฝั่งตรงข้ามกรอบ/1.0-1.5×ATR แล้วคุมเงินด้วย position size แทนการบีบ SL
        const slDist = Math.min(Math.max(width, 1.0 * atrH), 1.5 * atrH);

        // research fix (false-breakout rate สูง): ห้ามใช้ blind STOP ดักทะลุ —
        // ต้องมีแท่ง 15m "ปิด" นอกกรอบยืนยันก่อน แล้วค่อยเทรด retest ของขอบ
        // + ORB study (Zarattini/Barbon/Aziz, 7,000 หุ้น 2016-23): edge ของ
        // breakout กระจุกเกือบทั้งหมดในรอบที่ relative volume สูง → แท่งยืนยัน
        // ต้องมี RVOL ≥ 1.2 ด้วย ไม่งั้นถือว่า break ไร้แรง
        const recent = m15.slice(-6);
        const confirmBarUp = recent.find((b) => b.close > rH + 0.05 * atrH);
        const confirmBarDn = recent.find((b) => b.close < rL - 0.05 * atrH);
        const brokeUpBar = !!confirmBarUp && confirmBarUp.rvol20 >= 1.2;
        const brokeDnBar = !!confirmBarDn && confirmBarDn.rvol20 >= 1.2;

        if (!brokeUpBar && !brokeDnBar) {
            if (confirmBarUp || confirmBarDn) {
                return this.noTrade(
                    `มีแท่งปิดนอกกรอบแต่ RVOL ${(confirmBarUp ?? confirmBarDn)!.rvol20.toFixed(2)} < 1.2 — break ไร้แรง volume ไม่หนุน (ORB evidence) ไม่เทรด`,
                );
            }
            return this.noTrade(
                'ยังไม่มีแท่ง 15m ปิดนอกกรอบเอเชีย — รอ break ที่ยืนยันด้วยแท่งปิดก่อน (กัน false breakout)',
            );
        }
        const brokeUp = brokeUpBar && !brokeDnBar ? true : brokeDnBar && !brokeUpBar ? false : price > (rH + rL) / 2;
        const bDir = brokeUp ? 1 : -1;

        if ((brokeUp && !bull) || (!brokeUp && bull)) {
            return this.noTrade(
                `มีแท่งปิดทะลุฝั่ง${brokeUp ? 'บน' : 'ล่าง'} แต่ทิศ 1H ขัด (EMA20 ${bull ? '>' : '<'} EMA50) — ไม่ไล่ (intraday #5)`,
            );
        }
        // EMA200(1h) macro filter — research: ช่วยตัด false breakout ได้มาก
        if (!this.ema200Ready(h1)) {
            return this.noTrade(
                `ข้อมูล 1h มี ${h1.length} แท่ง ไม่พอให้ EMA200 อุ่นตัว (ต้อง >= 250) — เช็ค macro filter ไม่ได้ ไม่เทรดรอบนี้`,
            );
        }
        if ((brokeUp && L1.close < L1.ema200) || (!brokeUp && L1.close > L1.ema200)) {
            return this.noTrade(
                `break ฝั่ง${brokeUp ? 'บน' : 'ล่าง'} แต่ราคาอยู่${brokeUp ? 'ใต้' : 'เหนือ'} EMA200(1h) ${this.f(ctx, L1.ema200)} — สวน macro filter`,
            );
        }
        const edge = brokeUp ? rH : rL;
        if (bDir * (price - edge) > 1.2 * atrH)
            return this.noTrade('ราคาวิ่งหนีขอบกรอบไปไกลแล้ว — เป้า 1.5×กรอบใกล้หมด ไม่ไล่');
        if (bDir * (price - edge) < -0.3 * atrH) {
            return this.noTrade('ราคากลับเข้ากรอบลึกหลังทะลุ (fake breakout) — ยกเลิก setup ตามวินัย');
        }
        const entry = this.avoidRound(ctx, edge, -bDir);
        const sl = this.avoidRound(ctx, entry - bDir * slDist, -bDir);
        ctx.notes.push(
            `แท่ง 15m ปิดทะลุกรอบ + ทิศ 1H/EMA200 หนุน → รอ retest ขอบกรอบ ${this.f(ctx, edge)} (intraday #2 retest)`,
        );
        return this.buildLevels(ctx, {
            orderType: brokeUp ? 'BUY_LIMIT' : 'SELL_LIMIT',
            entry,
            sl,
            dir: bDir,
            playbook: 'intraday #2',
            sizeBase: 'full',
            magnets: [],
            validHours: 6,
            confBase: 6 + (this.emaTrendAligned(h1, brokeUp) ? 1 : 0),
            tpOverride: this.avoidRound(ctx, entry + bDir * Math.max(1.5 * width, ctx.rrMin * slDist), bDir),
        });
    }

    // ================= mode: SCALP =================

    private analyzeScalp(ctx: Ctx): GoldDecision {
        const m5 = this.closed(ctx, seriesKey(ctx.p, '5m'));
        const m15 = this.closed(ctx, seriesKey(ctx.p, '15m'));
        if (m5.length < 120 || m15.length < 40) return this.noTrade('ข้อมูล 5m/15m ไม่พอ');

        const atr5 = m5[m5.length - 1].atr14;
        const bull15 = m15[m15.length - 1].ema20 > m15[m15.length - 1].ema50;

        // Setup A — liquidity sweep within the last 6 closed 5m bars (scalp #1)
        const look = 60;
        for (let j = m5.length - 1; j >= m5.length - 6 && j > look; j--) {
            const bar = m5[j];
            const priorHi = Math.max(...m5.slice(j - look, j).map((b) => b.high));
            const priorLo = Math.min(...m5.slice(j - look, j).map((b) => b.low));

            const sweptLow = bar.low < priorLo && bar.close > priorLo; // sweep lows, reclaim
            const sweptHigh = bar.high > priorHi && bar.close < priorHi; // sweep highs, reject
            if (!sweptLow && !sweptHigh) continue;

            const dir = sweptLow ? 1 : -1;
            if (dir > 0 !== bull15) {
                ctx.notes.push(`เจอ sweep ${sweptLow ? 'ก้นต่ำ' : 'ยอดสูง'} แต่ทิศ 15m ขัด — ข้าม`);
                continue;
            }

            // research: คำวิจารณ์หลักของ sweep-trading คือ "เห็น sweep = เข้าเลย"
            // ทั้งที่ sweep จำนวนมากคือเทรนด์จริงวิ่งต่อ — เอาเฉพาะ sweep คุณภาพสูง:
            // แท่ง rejection ต้องมี displacement (range กว้าง + ปิดสวนกลับแรง + volume)
            const barRange = bar.high - bar.low;
            const closePos = barRange > 0 ? (bar.close - bar.low) / barRange : 0.5; // 0=ปิดก้น 1=ปิดยอด
            const strongClose = dir > 0 ? closePos >= 0.6 : closePos <= 0.4;
            if (barRange < 1.1 * atr5 || !strongClose || bar.rvol20 < 1.3) {
                ctx.notes.push(
                    `sweep ที่ ${this.f(ctx, sweptLow ? bar.low : bar.high)} ไม่ผ่านเกณฑ์คุณภาพ (range ${this.f(ctx, barRange)}/${this.f(ctx, 1.1 * atr5)} · close ${(closePos * 100).toFixed(0)}% · RVOL ${bar.rvol20.toFixed(2)}) — ข้าม`,
                );
                continue;
            }

            const level = sweptLow ? priorLo : priorHi; // the swept pool
            const extreme = sweptLow ? bar.low : bar.high; // sweep tip
            const entry = this.avoidRound(ctx, level + dir * 0.15 * atr5, -dir); // retest of the reclaimed level
            const sl = this.avoidRound(ctx, extreme - dir * 0.6 * atr5, -dir); // playbook: 0.5–0.8×ATR beyond sweep
            const risk = dir * (entry - sl);
            if (risk <= 0) continue;
            // เป้าสมจริง (ทอง $2–4.5 · คู่เงินตาม profile.scalp) (scalp #5), เคารพ rr ขั้นต่ำ
            const tp1 = this.capBeforeRound(
                ctx,
                entry + dir * Math.min(Math.max(ctx.rrMin * risk, ctx.p.scalp.min), ctx.p.scalp.max),
                dir,
            );
            if ((dir * (tp1 - entry)) / risk < ctx.rrMin) {
                ctx.notes.push('sweep เจอแต่ R:R หลังหลบเลขกลมไม่ถึงเกณฑ์ — ข้าม');
                continue;
            }

            ctx.notes.push(
                `Liquidity sweep ${sweptLow ? 'กวาด low' : 'กวาด high'} ที่ ${this.f(ctx, extreme)} แล้ว reclaim ${this.f(ctx, level)} (scalp #1) · ทิศ 15m หนุน`,
            );
            return this.finishDecision(ctx, {
                order_type: dir > 0 ? 'BUY_LIMIT' : 'SELL_LIMIT',
                entry,
                sl,
                tp1,
                tp2: this.capBeforeRound(ctx, entry + dir * (dir * (tp1 - entry)) * 1.8, dir),
                playbook: 'scalp #1',
                size: 'half',
                validHours: 0.75,
                conf: 5 + 1 + (m5[m5.length - 1].rvol20 > 1.2 ? 1 : 0),
                dir,
            });
        }

        // Setup B — Asian-range break-retest on 5m (scalp #2)
        const range = this.asianRange(m5, Date.now());
        if (range) {
            const { hi: rH, lo: rL } = range;
            const price = this.livePrice(ctx, [seriesKey(ctx.p, '5m')]);
            const brokeUp = price > rH + 0.1 * atr5;
            const brokeDn = price < rL - 0.1 * atr5;
            if ((brokeUp && bull15) || (brokeDn && !bull15)) {
                const dir = brokeUp ? 1 : -1;
                const edge = brokeUp ? rH : rL;
                if (dir * (price - edge) < 1.0 * (rH - rL)) {
                    const entry = this.avoidRound(ctx, edge, -dir);
                    const sl = this.avoidRound(ctx, entry - dir * 0.7 * atr5 * 2, -dir);
                    const risk = dir * (entry - sl);
                    const tp1 = this.capBeforeRound(
                        ctx,
                        entry + dir * Math.max(ctx.rrMin * risk, Math.min(1.5 * (rH - rL), ctx.p.scalp.breakCap)),
                        dir,
                    );
                    if ((dir * (tp1 - entry)) / risk >= ctx.rrMin) {
                        ctx.notes.push(
                            `Break กรอบเอเชีย ${this.f(ctx, rL)}–${this.f(ctx, rH)} ฝั่ง${brokeUp ? 'บน' : 'ล่าง'} → รอ retest ขอบ (scalp #2)`,
                        );
                        return this.finishDecision(ctx, {
                            order_type: dir > 0 ? 'BUY_LIMIT' : 'SELL_LIMIT',
                            entry,
                            sl,
                            tp1,
                            tp2: this.capBeforeRound(ctx, entry + dir * (dir * (tp1 - entry)) * 1.7, dir),
                            playbook: 'scalp #2',
                            size: 'half',
                            validHours: 0.75,
                            conf: 5 + 1,
                            dir,
                        });
                    }
                }
            }
        }

        return this.noTrade('ไม่มี setup sweep/break-retest ที่เข้าเกณฑ์ในรอบนี้ — NO-TRADE ตามวินัย scalp');
    }

    // ================= shared level building =================

    private buildLevels(
        ctx: Ctx,
        p: {
            orderType: GoldOrderType;
            entry: number;
            sl: number;
            dir: number;
            playbook: string;
            sizeBase: GoldSize;
            magnets: number[];
            validHours: number;
            confBase: number;
            tpOverride?: number;
        },
    ): GoldDecision {
        const { dir } = p;
        const risk = dir * (p.entry - p.sl);
        if (risk <= 0) return this.noTrade('ระดับ SL/Entry ไม่สมเหตุผล');

        let tp1 = p.tpOverride ?? p.entry + dir * ctx.rrMin * risk * 1.1;
        tp1 = this.capBeforeRound(ctx, tp1, dir);
        // magnets (leg high/low) as caps: don't target through the leg extreme
        for (const m of p.magnets) {
            if (dir > 0 && m > p.entry && tp1 > m - 0.1 * risk) tp1 = Math.min(tp1, m - 0.1 * risk);
            if (dir < 0 && m < p.entry && tp1 < m + 0.1 * risk) tp1 = Math.max(tp1, m + 0.1 * risk);
        }
        const rr1 = (dir * (tp1 - p.entry)) / risk;
        if (rr1 < ctx.rrMin) {
            return this.noTrade(
                `เป้าที่สมจริง (หลบเลขกลม/แม่เหล็ก) ให้ R:R ${rr1.toFixed(2)} < เกณฑ์ ${ctx.rrMin} — ไม่คุ้ม (playbook ${p.playbook})`,
            );
        }
        const tp2 = this.capBeforeRound(ctx, p.entry + dir * Math.max(rr1 * 1.7, ctx.rrMin * 1.6) * risk, dir);

        return this.finishDecision(ctx, {
            order_type: p.orderType,
            entry: p.entry,
            sl: p.sl,
            tp1,
            tp2,
            playbook: p.playbook,
            size: p.sizeBase,
            validHours: p.validHours,
            conf: p.confBase,
            dir,
        });
    }

    private finishDecision(
        ctx: Ctx,
        p: {
            order_type: GoldOrderType;
            entry: number;
            sl: number;
            tp1: number;
            tp2: number;
            playbook: string;
            size: GoldSize;
            validHours: number;
            conf: number;
            dir: number;
        },
    ): GoldDecision {
        const r2 = (v: number) => roundPrice(ctx.p, v); // ทศนิยมตามตราสาร (ทอง 2 = เดิม)
        const risk = p.dir * (p.entry - p.sl);
        const d: GoldDecision = {
            order_type: p.order_type,
            entry: r2(p.entry),
            sl: r2(p.sl),
            tp1: r2(p.tp1),
            tp2: r2(p.tp2),
            rr_tp1: Math.round(((p.dir * (p.tp1 - p.entry)) / risk) * 100) / 100,
            confidence: Math.max(0, Math.min(10, Math.round(p.conf))),
            size: p.size,
            valid_until_utc: new Date(Date.now() + p.validHours * 3_600_000).toISOString(),
            invalidation:
                p.dir > 0
                    ? `ปิดแท่ง TF สั่งการต่ำกว่า ${r2(p.sl)} หรือโครงสร้างเปลี่ยนทิศ`
                    : `ปิดแท่ง TF สั่งการเหนือ ${r2(p.sl)} หรือโครงสร้างเปลี่ยนทิศ`,
            playbook_ref: p.playbook,
            reason: ctx.notes[ctx.notes.length - 1] ?? p.playbook,
            analysis_summary_th: '',
        };
        d.analysis_summary_th = this.summary(ctx, d);
        this.logger.log(
            `[${ctx.p.key} ${ctx.mode}] TA: ${d.order_type} @ ${d.entry} SL ${d.sl} TP1 ${d.tp1} RR ${d.rr_tp1} conf ${d.confidence} (${d.playbook_ref})`,
        );
        return d;
    }

    // ================= companions =================

    private scoreCompanions(ctx: Ctx) {
        // weight: +ve value = companion up supports the instrument up
        // ตารางน้ำหนัก/ป้ายมาจาก profile.companions — โหมดช้า (swing/position) ใช้ wSlow
        // + ป้าย slow, โหมดเร็วใช้ wFast + ป้าย fast (ป้ายเป็น string เดียว = ใช้ทั้งสองโหมด)
        // NOTE ทอง (research 2023-25, multi-source: VanEck/RBC/JPM/PIMCO): the classic
        // gold–real-yield inverse correlation BROKE (84% -> ~3-7% since 2022) —
        // central-bank buying is the new marginal driver and the relationship is
        // now asymmetric (yields up hurts gold much less than before). US10Y/DXY
        // therefore carry REDUCED weight on the slow modes (swing/position);
        // intraday correlations are still intact enough to keep fuller weight.
        // (ตัวเลขเหล่านี้อยู่ใน XAUUSD_PROFILE.companions — ลำดับ/ค่าเดิมเป๊ะ)
        const slow = ctx.mode === 'swing' || ctx.mode === 'position';
        const table: Array<[string, number, string]> = ctx.p.companions.map((c) => [
            c.sym,
            slow ? c.wSlow : c.wFast,
            typeof c.label_th === 'string' ? c.label_th : slow ? c.label_th.slow : c.label_th.fast,
        ]);
        let score = 0;
        for (const [sym, w, label] of table) {
            const key = this.companionKey(ctx, sym);
            if (!key) continue;
            const bars = this.closed(ctx, key);
            if (bars.length < 25) continue;
            const b = bars[bars.length - 1];
            const trend = (b.close > b.ema20 ? 1 : -1) + (b.ema20 > b.ema50 ? 1 : -1); // -2..2
            const dirTxt = trend > 0 ? 'ขึ้น' : trend < 0 ? 'ลง' : 'ข้าง';
            const contrib = w * Math.sign(trend);
            score += contrib;
            ctx.compNotes.push(
                `${sym.toUpperCase()} ${dirTxt} (${contrib > 0 ? '+' : ''}${contrib.toFixed(2)}) ${label}`,
            );
        }
        ctx.compScore = Math.max(-3, Math.min(3, Math.round(score * 2) / 2));
    }

    /**
     * EMA200 เชื่อได้หรือยัง — ต้องมีแท่งพอให้ค่า seed จางไปแล้ว
     *
     * EMA ในระบบนี้ seed ด้วย values[0] (เท่ากับ pandas ewm(adjust=False))
     * น้ำหนักที่ seed ยังเหลืออยู่ = (1 - 2/201)^n
     *   60 แท่ง = 54.9%  ·  120 = 30.1%  ·  200 = 13.5%  ·  250 = 8.2%  ·  400 = 1.8%
     * ที่ 60 แท่ง (พื้นขั้นต่ำของ checkDataIntegrity) EMA200 คือ "ราคาเก่าหนึ่งแท่ง" เกินครึ่ง
     * มันจะวิ่งตามราคาไปเรื่อย ๆ = ด่าน macro/regime แทบไม่ปฏิเสธอะไรเลย และฝั่งเทรดของ
     * swing (EMA50 vs EMA200) ก็เพี้ยนตาม · รอบปกติส่งมา 300-400 แท่งอยู่แล้ว
     * เกณฑ์นี้จึงกระทบเฉพาะรอบที่ข้อมูลมาไม่ครบ
     */
    private ema200Ready(bars: EnrichedBar[]): boolean {
        return bars.length >= 250;
    }

    /**
     * เลือก series ของตัวประกอบแบบ "ช้าที่สุดที่มี" — ห้ามใช้ find() เอาตัวแรกที่เจอ
     *
     * บางโหมดส่งตัวประกอบตัวเดียวกันมา 2 TF (XAUUSD swing: DXY 4h+1d ·
     * XAUUSD position: GDX 1d+1w · USDJPY swing: US10Y 4h+1d) และ key ถูกใส่เข้า
     * series ตามลำดับที่ network ตอบกลับ -> find() = หยิบตาม "ใครตอบก่อน"
     * สอง TF เห็นเทรนด์คนละทางเมื่อไหร่ คะแนนแกว่งพอข้ามด่าน veto ได้
     * = ข้อมูลชุดเดิมให้คำตอบคนละอย่างข้ามรอบ cache และไล่จาก log ไม่เจอ
     *
     * ทุกเคสที่ซ้ำ TF ที่ "เกินมา" คือตัวเร็ว ส่วนตัวช้าคือตัวที่ตรงกับตัวประกอบอื่น
     * ทั้งหมดในโหมดนั้น (swing=1d · position=1w) และตรงกับน้ำหนัก wSlow ที่ใช้อยู่
     */
    private companionKey(ctx: Ctx, sym: string): string | null {
        const pre = `${sym}_`;
        let best: string | null = null,
            bestMs = -1;
        for (const k of Object.keys(ctx.series)) {
            if (!k.startsWith(pre)) continue;
            const ms = INTERVAL_MS[k.slice(pre.length)] ?? 0;
            if (ms > bestMs) {
                bestMs = ms;
                best = k;
            }
        }
        return best;
    }

    /** lead indicator ของโปรไฟล์ (ทอง = GDX) คอนเฟิร์มทิศไหม — ไม่มี lead = false */
    private leadConfirms(ctx: Ctx, bull: boolean): boolean {
        const lead = ctx.p.leadIndicator;
        if (!lead) return false;
        const key = this.companionKey(ctx, lead);
        if (!key) return false;
        const bars = this.closed(ctx, key);
        if (bars.length < 25) return false;
        const b = bars[bars.length - 1];
        return bull ? b.close > b.ema20 : b.close < b.ema20;
    }

    // ================= primitives =================

    private closed(ctx: Ctx, key: string): EnrichedBar[] {
        const bars = ctx.series[key] ?? [];
        if (!bars.length) return bars;
        const tf = key.split('_').pop()!;
        const dur = INTERVAL_MS[tf] ?? 0;
        return Date.now() - bars[bars.length - 1].ts < dur ? bars.slice(0, -1) : bars;
    }

    /** newest price available: last (possibly live) bar close of the first series that exists */
    private livePrice(ctx: Ctx, keys: string[]): number {
        for (const k of keys) {
            const bars = ctx.series[k];
            if (bars?.length) return bars[bars.length - 1].close;
        }
        throw new Error('no price series');
    }

    private pivots(bars: EnrichedBar[], k: number): { highs: Pivot[]; lows: Pivot[] } {
        const highs: Pivot[] = [],
            lows: Pivot[] = [];
        for (let i = k; i < bars.length - k; i++) {
            let isH = true,
                isL = true;
            for (let j = i - k; j <= i + k; j++) {
                if (bars[j].high > bars[i].high) isH = false;
                if (bars[j].low < bars[i].low) isL = false;
                if (!isH && !isL) break;
            }
            if (isH) highs.push({ i, price: bars[i].high, ts: bars[i].ts });
            if (isL) lows.push({ i, price: bars[i].low, ts: bars[i].ts });
        }
        return { highs, lows };
    }

    /** most recent impulse leg in the trend direction (bull: pivot low -> later pivot high) */
    private lastLeg(bars: EnrichedBar[], bull: boolean, k: number): Leg | null {
        const { highs, lows } = this.pivots(bars.slice(-140), k);
        if (!highs.length || !lows.length) return null;
        if (bull) {
            const hi = highs[highs.length - 1];
            const priorLows = lows.filter((l) => l.i < hi.i);
            if (!priorLows.length) return null;
            let lo = priorLows[priorLows.length - 1];
            for (let x = priorLows.length - 1; x >= 0; x--) {
                if (priorLows[x].price < lo.price) lo = priorLows[x];
                if (hi.i - priorLows[x].i > 60) break;
            }
            if (hi.price - lo.price <= 0) return null;
            return { lo, hi, up: true };
        }
        const lo = lows[lows.length - 1];
        const priorHighs = highs.filter((h) => h.i < lo.i);
        if (!priorHighs.length) return null;
        let hi = priorHighs[priorHighs.length - 1];
        for (let x = priorHighs.length - 1; x >= 0; x--) {
            if (priorHighs[x].price > hi.price) hi = priorHighs[x];
            if (lo.i - priorHighs[x].i > 60) break;
        }
        if (hi.price - lo.price <= 0) return null;
        return { lo, hi, up: false };
    }

    private recentExtreme(bars: EnrichedBar[], n: number, side: 'low' | 'high'): number {
        const tail = bars.slice(-n);
        return side === 'low' ? Math.min(...tail.map((b) => b.low)) : Math.max(...tail.map((b) => b.high));
    }

    /** hammer / engulfing on the last closed bar, in the trade direction */
    private reversalConfirmation(bars: EnrichedBar[], bull: boolean): string | null {
        if (bars.length < 3) return null;
        const c = bars[bars.length - 1],
            p = bars[bars.length - 2];
        const body = Math.abs(c.close - c.open);
        const range = c.high - c.low;
        if (range <= 0) return null;
        if (bull) {
            const lowerWick = Math.min(c.open, c.close) - c.low;
            if (c.close > c.open && lowerWick > body * 1.8 && lowerWick > range * 0.5) return 'hammer';
            if (c.close > c.open && p.close < p.open && c.close > p.open && c.open < p.close)
                return 'bullish engulfing';
        } else {
            const upperWick = c.high - Math.max(c.open, c.close);
            if (c.close < c.open && upperWick > body * 1.8 && upperWick > range * 0.5) return 'shooting star';
            if (c.close < c.open && p.close > p.open && c.close < p.open && c.open > p.close)
                return 'bearish engulfing';
        }
        return null;
    }

    private emaTrendAligned(bars: EnrichedBar[], bull: boolean): boolean {
        const b = bars[bars.length - 1];
        return bull ? b.ema20 > b.ema50 : b.ema20 < b.ema50;
    }

    private rsiInPullbackZone(bars: EnrichedBar[], bull: boolean): boolean {
        const rsi = bars[bars.length - 1].rsi;
        return bull ? rsi >= 32 && rsi <= 55 : rsi >= 45 && rsi <= 68;
    }

    /** Asian session today: 23:00 UTC (prev day) – 07:00 UTC; needs the full window closed */
    private asianRange(bars: EnrichedBar[], now: number): { hi: number; lo: number } | null {
        const d = new Date(now);
        const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
        if (utcMin < 7 * 60 + 10) return null; // range not complete yet (before 14:10 ไทย)
        const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 0);
        const start = end - 8 * 3_600_000;
        const win = bars.filter((b) => b.ts >= start && b.ts < end);
        if (win.length < 10) return null;
        return { hi: Math.max(...win.map((b) => b.high)), lo: Math.min(...win.map((b) => b.low)) };
    }

    /**
     * keep a level off exact round numbers (they get swept). dirAway = shift direction
     * ระยะเลขกลม/บัฟเฟอร์มาจากโปรไฟล์ (ทอง step $50 · buffer $1.6 — เลขเดิมเป๊ะ)
     */
    private avoidRound(ctx: Ctx, level: number, dirAway: number): number {
        const step = ctx.p.round.step,
            buf = ctx.p.round.buffer;
        const nearest = Math.round(level / step) * step;
        if (Math.abs(level - nearest) < buf) return nearest + dirAway * buf;
        return level;
    }

    /**
     * don't target through the next round number — cap TP just in front of it
     * (ทอง step $50 · tpBuffer $2.0 — เลขเดิมเป๊ะ)
     */
    private capBeforeRound(ctx: Ctx, tp: number, dir: number): number {
        const step = ctx.p.round.step,
            buf = ctx.p.round.tpBuffer;
        const next = dir > 0 ? Math.ceil(tp / step) * step : Math.floor(tp / step) * step;
        const prev = dir > 0 ? next - step : next + step;
        // if tp sits within buffer beyond a round it just crossed, pull it back in front
        if (dir > 0 && tp > prev && tp - prev < buf && prev > 0) return prev - buf;
        if (dir < 0 && tp < prev && prev - tp < buf) return prev + buf;
        // if tp is within buffer in front of the next round, leave it; if beyond, cap at round - buffer
        if (dir > 0 && tp > next - buf) return next - buf;
        if (dir < 0 && tp < next + buf) return next + buf;
        return tp;
    }

    /** format ราคาตามทศนิยมของตราสาร (ทอง 2 ตำแหน่ง = เดิม) */
    private f(ctx: Ctx, v: number): string {
        return fmtPrice(ctx.p, v);
    }

    private summary(ctx: Ctx, d: GoldDecision): string {
        const lines = [
            `โหมด ${ctx.mode} · ${ctx.p.key} (TA engine — วิเคราะห์จาก indicator จริง ไม่ใช้ AI)`,
            ...ctx.notes.map((n) => `• ${n}`),
            `• ตัวประกอบสุทธิ: ${ctx.compScore > 0 ? 'หนุนฝั่งขึ้น' : ctx.compScore < 0 ? 'กดฝั่งลง' : 'กลาง'} (score ${ctx.compScore})`,
            ...ctx.compNotes.slice(0, 5).map((n) => `   - ${n}`),
        ];
        if (d.order_type !== 'NO_TRADE') {
            lines.push(
                `• แผน A: ${d.order_type} @ ${d.entry} | SL ${d.sl} | TP1 ${d.tp1} | TP2 ${d.tp2} (R:R ${d.rr_tp1})`,
            );
            lines.push(`• แผน B: ถ้า ${d.invalidation} → ยกเลิกออเดอร์ รอ setup ใหม่`);
        }
        return lines.join('\n');
    }

    /**
     * จุดเดียวที่สร้าง NO_TRADE ทั้งหมด (25 ที่เรียก) — ติดธง near_miss ที่นี่ครั้งเดียว
     * จึงไม่ต้องไล่แก้ทุกจุดเวลาปรับนโยบาย แค่แก้ NEAR_MISS_RULES ด้านบน
     * @param kind บังคับประเภทได้เมื่อรู้แน่ (ข้ามการจับจากข้อความ)
     */
    private noTrade(reason: string, kind?: 'near_miss' | 'no_setup'): GoldDecision {
        const c = kind
            ? { near_miss: kind === 'near_miss', near_miss_rule: kind === 'near_miss' ? 'explicit' : null }
            : classifyNoTrade(reason);
        this.logger.log(`TA NO_TRADE${c.near_miss ? ` [เฉียด: ${c.near_miss_rule}]` : ''}: ${reason}`);
        return {
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
            near_miss: c.near_miss,
            near_miss_rule: c.near_miss_rule ?? undefined,
        };
    }
}
