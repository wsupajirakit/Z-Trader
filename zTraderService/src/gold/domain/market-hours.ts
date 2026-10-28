/**
 * เวลาทำการของตลาด — รองรับทั้งโลหะ (XAUUSD) และ forex
 *
 * โลหะ (spot gold / CFD):
 *   เปิด: อาทิตย์ 18:00 ET → ศุกร์ 17:00 ET
 *   พักรายวัน: 17:00–18:00 ET ทุกวันทำการ (rollover — spread ถ่างมาก)
 *
 * Forex (IC Markets: อาทิตย์ 22:05 GMT → ศุกร์ 21:55 GMT):
 *   เปิด: อาทิตย์ 17:05 ET → ศุกร์ 16:55 ET · ไม่มีพักรายวัน (แต่ spread ถ่างช่วง rollover 17:00 ET)
 *
 * ใช้ America/New_York เพื่อให้ถูกต้องอัตโนมัติทั้งช่วง EST และ EDT
 */

export interface MarketHoursSpec {
    /** นาที ET ที่ตลาดเปิดคืนวันอาทิตย์ */
    openMin: number;
    /** นาที ET ที่ตลาดปิดวันศุกร์ */
    closeMin: number;
    /** ช่วงพักรายวัน [เริ่ม, จบ] นาที ET — null = ไม่มีพัก */
    dailyBreak: [number, number] | null;
    /** ชื่อตลาดสำหรับข้อความ เช่น "ตลาดทอง" / "ตลาด forex" */
    label_th: string;
    /** ข้อความเวลาเปิดสำหรับคน เช่น "อาทิตย์ 18:00 ET / จันทร์ 06:00 ไทย" */
    openText_th: string;
}

export const METALS_HOURS: MarketHoursSpec = {
    openMin: 18 * 60,
    closeMin: 17 * 60,
    dailyBreak: [17 * 60, 18 * 60],
    label_th: 'ตลาดทอง',
    openText_th: 'อาทิตย์ 18:00 ET / จันทร์ 06:00 ไทย',
};

export const FX_HOURS: MarketHoursSpec = {
    openMin: 17 * 60 + 5,
    closeMin: 16 * 60 + 55,
    dailyBreak: null,
    label_th: 'ตลาดค่าเงิน',
    openText_th: 'อาทิตย์ 17:05 ET / จันทร์ 05:05 ไทย',
};

export interface MarketStatus {
    open: boolean;
    reason: string; // ข้อความภาษาไทยอธิบายสถานะ
    phase: 'open' | 'daily_break' | 'weekend';
    et_time: string; // HH:mm ET
    next_open_utc: string | null; // ISO — null เมื่อเปิดอยู่แล้ว
    minutes_to_open: number | null; // อีกกี่นาทีจะเปิด
    minutes_to_close: number | null; // อีกกี่นาทีจะปิด (เมื่อเปิดอยู่)
}

/** อ่านเวลา/วันตามโซน New York (รองรับ DST อัตโนมัติ) */
export function etParts(now: Date): { min: number; dow: number } {
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

const DAY = 24 * 60;

export function marketStatus(now = new Date(), hours: MarketHoursSpec = METALS_HOURS): MarketStatus {
    const { min, dow } = etParts(now);
    const et = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    const mk = (o: Partial<MarketStatus>): MarketStatus => ({
        open: false,
        reason: '',
        phase: 'open',
        et_time: et,
        next_open_utc: null,
        minutes_to_open: null,
        minutes_to_close: null,
        ...o,
    });
    const openHHMM = `${String(Math.floor(hours.openMin / 60)).padStart(2, '0')}:${String(hours.openMin % 60).padStart(2, '0')}`;
    const closeHHMM = `${String(Math.floor(hours.closeMin / 60)).padStart(2, '0')}:${String(hours.closeMin % 60).padStart(2, '0')}`;

    // เสาร์ = ปิดทั้งวัน
    if (dow === 6) {
        const mins = DAY - min + hours.openMin; // เหลือของเสาร์ + ถึงเวลาเปิดวันอาทิตย์
        return mk({
            phase: 'weekend',
            reason: `${hours.label_th}ปิดสุดสัปดาห์ (เสาร์) — เปิดอีกที${hours.openText_th}`,
            minutes_to_open: Math.round(mins),
            next_open_utc: nextOpenIso(now, mins),
        });
    }
    // อาทิตย์ก่อนเวลาเปิด = ยังปิด
    if (dow === 0 && min < hours.openMin) {
        const mins = hours.openMin - min;
        return mk({
            phase: 'weekend',
            reason: `${hours.label_th}ยังปิด (สุดสัปดาห์) — เปิด ${openHHMM} ET อีก ${fmt(mins)}`,
            minutes_to_open: mins,
            next_open_utc: nextOpenIso(now, mins),
        });
    }
    // ศุกร์หลังเวลาปิด = ปิดยาวถึงอาทิตย์
    if (dow === 5 && min >= hours.closeMin) {
        const mins = DAY - min + DAY + hours.openMin; // เหลือของศุกร์ + เสาร์ + ถึงเวลาเปิดอาทิตย์
        return mk({
            phase: 'weekend',
            reason: `${hours.label_th}ปิดสุดสัปดาห์แล้ว (ศุกร์ ${closeHHMM} ET) — เปิดอีกที${hours.openText_th}`,
            minutes_to_open: mins,
            next_open_utc: nextOpenIso(now, mins),
        });
    }
    // พักรายวัน (เฉพาะตลาดที่มี)
    if (hours.dailyBreak) {
        const [bStart, bEnd] = hours.dailyBreak;
        if (min >= bStart && min < bEnd) {
            const mins = bEnd - min;
            const bs = `${String(Math.floor(bStart / 60)).padStart(2, '0')}:${String(bStart % 60).padStart(2, '0')}`;
            const be = `${String(Math.floor(bEnd / 60)).padStart(2, '0')}:${String(bEnd % 60).padStart(2, '0')}`;
            return mk({
                phase: 'daily_break',
                reason: `${hours.label_th}พักรายวัน ${bs}–${be} ET (rollover spread ถ่าง) — เปิดอีก ${fmt(mins)}`,
                minutes_to_open: mins,
                next_open_utc: nextOpenIso(now, mins),
            });
        }
    }

    // เปิดอยู่ — คำนวณว่าอีกนานแค่ไหนจะถึงเวลาปิดรอบถัดไป
    let toClose: number;
    if (hours.dailyBreak) {
        const bStart = hours.dailyBreak[0];
        toClose = min < bStart ? bStart - min : DAY - min + bStart;
    } else {
        // ไม่มีพักรายวัน → ปิดครั้งถัดไปคือศุกร์เวลาปิด
        const daysToFri = dow === 5 ? 0 : (5 - dow + 7) % 7;
        toClose = daysToFri * DAY + hours.closeMin - min;
    }
    return mk({ open: true, phase: 'open', reason: `${hours.label_th}เปิด (${et} ET)`, minutes_to_close: toClose });
}

function fmt(mins: number): string {
    if (mins < 60) return `${mins} นาที`;
    const h = Math.floor(mins / 60),
        m = mins % 60;
    return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

function nextOpenIso(now: Date, minutesAhead: number): string {
    return new Date(now.getTime() + minutesAhead * 60_000).toISOString();
}
