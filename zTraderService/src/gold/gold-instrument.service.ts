import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CtraderService } from '../ctrader/ctrader.service';
import { errorMessage } from '../common/utils/errors';
import { DomainError } from './domain/domain-error';
import {
    DEFAULT_INSTRUMENT,
    INSTRUMENT_KEYS,
    INSTRUMENTS,
    InstrumentKey,
    InstrumentProfile,
    getProfile,
    isInstrumentKey,
} from './domain/instruments';

/**
 * ตราสารที่บอทกำลังเทรด ("active instrument") + การหา symbolId บน cTrader
 *
 * - ค่าเริ่มต้นจาก env TRADE_INSTRUMENT (default XAUUSD) · เปลี่ยนได้ตอนรันจาก dashboard
 * - symbolId: env override (<profile.symbolIdEnv>) → ค่า default ของโปรไฟล์ (ทอง=41)
 *   → ค้นจาก ProtoOASymbolsListReq ด้วยชื่อ symbol (แคชไว้จนกว่าจะรีสตาร์ท)
 * - เก็บ map symbolId → profile ไว้ให้ตัวจัดการ position ดูแลไม้ทุกตราสารพร้อมกันได้
 */
@Injectable()
export class GoldInstrumentService {
    private readonly logger = new Logger(GoldInstrumentService.name);
    private runtimeKey: InstrumentKey | null = null;
    private idCache = new Map<InstrumentKey, number>();
    private idByNumber = new Map<number, InstrumentKey>();
    private listPromise: Promise<any[]> | null = null;
    private resolvedAll = false;

    constructor(
        private configService: ConfigService,
        private ctraderService: CtraderService,
    ) {}

    /** โปรไฟล์ของตราสารที่เลือกอยู่ตอนนี้ */
    get active(): InstrumentProfile {
        if (this.runtimeKey) return INSTRUMENTS[this.runtimeKey];
        return getProfile(this.configService.get<string>('TRADE_INSTRUMENT', DEFAULT_INSTRUMENT));
    }

    get activeKey(): InstrumentKey {
        return this.active.key;
    }

    list() {
        return INSTRUMENT_KEYS.map((k) => {
            const p = INSTRUMENTS[k];
            return {
                key: k,
                name_th: p.name_th,
                emoji: p.emoji,
                kind: p.kind,
                digits: p.digits,
                pip: p.pip,
                units_per_lot: p.unitsPerLot,
                quote_ccy: p.quoteCcy,
                daily_range_th: p.typicalDailyRange_th,
                symbol_id: this.idCache.get(k) ?? this.knownSymbolId(p),
                active: k === this.activeKey,
            };
        });
    }

    /** เปลี่ยนตราสาร — ผู้เรียก (automate) ต้องเช็คก่อนว่า loop หยุดอยู่ */
    setActive(key: string): InstrumentProfile {
        const k = (key ?? '').toUpperCase();
        if (!isInstrumentKey(k))
            throw new DomainError(`ไม่รู้จักตราสาร "${key}" — เลือกได้: ${INSTRUMENT_KEYS.join(', ')}`);
        this.runtimeKey = k;
        this.logger.log(`active instrument → ${k}`);
        return INSTRUMENTS[k];
    }

    /** symbolId ที่รู้โดยไม่ต้องถาม broker (env หรือ default ของโปรไฟล์) — null = ต้องค้น */
    knownSymbolId(p: InstrumentProfile): number | null {
        const raw = this.configService.get<string>(p.symbolIdEnv);
        if (raw !== undefined && raw !== '') {
            const v = parseInt(raw, 10);
            if (Number.isFinite(v) && v > 0) return v;
        }
        return p.defaultSymbolId;
    }

    /**
     * symbolId ของตราสาร — ถามจาก cTrader ครั้งแรกแล้วแคช
     * โยน error ถ้าหาไม่เจอ (ผู้เรียกต้องไม่เทรดต่อ)
     */
    async resolveSymbolId(p: InstrumentProfile = this.active): Promise<number> {
        const cached = this.idCache.get(p.key);
        if (cached) return cached;
        const known = this.knownSymbolId(p);
        if (known) {
            this.remember(p.key, known);
            return known;
        }
        if (!this.ctraderService.isAuthorized)
            throw new DomainError(`หา symbolId ของ ${p.key} ไม่ได้: cTrader ยังไม่ authorized`);
        const symbols = await this.symbolList();
        const hit = symbols.find((s) => String(s.symbolName ?? '').toUpperCase() === p.symbolName.toUpperCase());
        if (!hit)
            throw new Error(
                `ไม่พบ symbol ${p.symbolName} บนบัญชี cTrader นี้ (ตั้ง ${p.symbolIdEnv} ใน env ถ้าชื่อต่างกัน)`,
            );
        const id = Number(hit.symbolId);
        this.remember(p.key, id);
        this.logger.log(`resolved ${p.key} → symbolId ${id}`);
        return id;
    }

    /** symbolId ที่แคชไว้แล้ว (ไม่ถาม broker) — ใช้ใน hot path เช่น onSpot */
    cachedSymbolId(p: InstrumentProfile = this.active): number | null {
        return this.idCache.get(p.key) ?? this.knownSymbolId(p);
    }

    /** โปรไฟล์จาก symbolId (เฉพาะที่เคย resolve/รู้ค่าแล้ว) — ใช้ดูแล position ทุกตราสาร */
    profileBySymbolId(symbolId: number): InstrumentProfile | null {
        const k = this.idByNumber.get(symbolId);
        if (k) return INSTRUMENTS[k];
        for (const key of INSTRUMENT_KEYS) {
            const known = this.knownSymbolId(INSTRUMENTS[key]);
            if (known === symbolId) {
                this.remember(key, known);
                return INSTRUMENTS[key];
            }
        }
        return null;
    }

    /**
     * resolve symbolId ของ "ทุก" ตราสารครั้งเดียวหลัง cTrader authorized
     *
     * ที่ต้องมี: profileBySymbolId คืน null สำหรับตราสารที่ยังไม่เคย resolve
     * → หลังรีสตาร์ท active กลับเป็น XAUUSD ไม้ FX ที่ค้างอยู่จะกลายเป็น "ไม้กำพร้า":
     *   manageOpenPositions ข้ามทิ้ง (ไม่ล็อกกันทุนที่ +1R ไม่ trail) และหน้า positions
     *   กรองออกจนคนดูเห็นว่า "ไม่มีไม้ค้าง" ทั้งที่มีจริง
     * ล้มตัวไหนข้ามตัวนั้น (broker บางเจ้าไม่มีคู่เงินครบ) แล้วให้ลองใหม่รอบหน้า
     */
    async resolveAll(): Promise<void> {
        if (this.resolvedAll || !this.ctraderService.isAuthorized) return;
        let ok = 0;
        for (const key of INSTRUMENT_KEYS) {
            if (this.idCache.has(key)) {
                ok++;
                continue;
            }
            try {
                await this.resolveSymbolId(INSTRUMENTS[key]);
                ok++;
            } catch (e) {
                this.logger.warn(
                    `resolve ${key} ไม่สำเร็จ: ${errorMessage(e)} — ไม้ของตราสารนี้จะยังดูแลไม่ได้จนกว่าจะ resolve ได้`,
                );
            }
        }
        // ครบทุกตัวแล้วค่อยหยุดลอง — ไม่งั้นลองใหม่ทุกรอบ tick
        if (ok === INSTRUMENT_KEYS.length) {
            this.resolvedAll = true;
            this.logger.log(`resolve symbolId ครบทุกตราสารแล้ว (${INSTRUMENT_KEYS.length} ตัว)`);
            void this.verifyDigits();
        }
    }

    /**
     * เทียบ digits ที่ broker บอก กับ digits ที่ hardcode ไว้ใน profile — "แจ้งเตือนอย่างเดียว"
     *
     * เราปัดราคา (roundPrice) และส่ง SL/TP เป็น double ตาม profile.digits ที่เขียนตายไว้
     * (XAU 2 · EUR/GBP 5 · JPY 3) โดยไม่เคยอ่านค่าจริงจาก broker เลย ทั้งที่ ProtoOASymbolByIdRes
     * ส่งมาให้อยู่แล้ว · ถ้า broker ใช้ทศนิยมไม่เท่ากัน order จะโดนปฏิเสธหรือปัดผิดโดยไม่มีอะไรฟ้อง
     * และยังไม่เคยยิง order คู่เงินจริงสักไม้ = ข้อสันนิษฐานนี้ไม่เคยถูกตรวจ
     *
     * จงใจไม่เอาค่า broker มาใช้แทนอัตโนมัติ — เปลี่ยนการปัดราคาเงียบ ๆ อันตรายกว่าปล่อยให้คนตัดสิน
     * ตรงนี้แค่ทำให้ "ถ้าไม่ตรง จะรู้ก่อนเสียเงิน"
     */
    private async verifyDigits(): Promise<void> {
        for (const key of INSTRUMENT_KEYS) {
            const prof = INSTRUMENTS[key];
            const id = this.idCache.get(key);
            if (!id) continue;
            try {
                const res: any = await this.ctraderService.getSymbolById(id);
                const sym = (res?.symbol ?? [])[0];
                const d = sym?.digits;
                if (d == null) continue;
                if (Number(d) !== prof.digits) {
                    this.logger.error(
                        `⚠ ${key}: broker ใช้ทศนิยม ${d} ตำแหน่ง แต่ profile ตั้งไว้ ${prof.digits} ` +
                            '— ราคา/SL/TP อาจถูกปัดผิดหรือโดน broker ปฏิเสธ ตรวจ instruments.ts ก่อนเทรดคู่นี้',
                    );
                } else {
                    this.logger.log(`digits ${key} ตรงกับ broker (${d})`);
                }
            } catch (e) {
                this.logger.warn(`เช็ค digits ของ ${key} ไม่ได้: ${errorMessage(e)}`);
            }
        }
    }

    private remember(key: InstrumentKey, id: number) {
        this.idCache.set(key, id);
        this.idByNumber.set(id, key);
    }

    private symbolList(): Promise<any[]> {
        if (!this.listPromise) {
            this.listPromise = this.ctraderService
                .request<any>(
                    'ProtoOASymbolsListReq',
                    {
                        ctidTraderAccountId: this.ctraderService.activeAccountId,
                        includeArchivedSymbols: false,
                    },
                    20_000,
                )
                .then((res) => (res?.symbol ?? []) as any[])
                .catch((e) => {
                    this.listPromise = null;
                    throw e;
                });
        }
        return this.listPromise;
    }
}
