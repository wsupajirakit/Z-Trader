import { BadRequestException } from '@nestjs/common';

export type AmountUnit = 'usd' | 'pct';
export interface Amount {
    unit: AmountUnit;
    value: number;
}

export const PROFILE_INSTRUMENTS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'] as const;
export type ProfileInstrument = (typeof PROFILE_INSTRUMENTS)[number];

/** what a risk profile sets; risk and daily stop may be a % of the account balance */
export interface RiskProfileValues {
    risk_per_trade: Amount;
    daily_max_loss: Amount;
    max_open_positions: number;
    max_open_positions_total: number;
    min_confidence: number;
    loss_cooldown_bars: number;
    scalp_max_per_day: number;
    /** optional lot caps per instrument; missing = left as they are */
    max_lot?: Partial<Record<ProfileInstrument, number>>;
}

export interface BuiltInProfile {
    id: string;
    name: string;
    description: string;
    values: RiskProfileValues;
}

const pct = (value: number): Amount => ({ unit: 'pct', value });
const usd = (value: number): Amount => ({ unit: 'usd', value });

/**
 * Built-in profiles. Balanced is the old dashboard formula (1% risk, daily stop = 4 trades of risk,
 * 4 open trades, conf 7); Micro account is the old tiny-account preset (risk $10 = 0.01 lot of gold
 * at the median scalp stop).
 */
export const BUILT_IN_PROFILES: readonly BuiltInProfile[] = [
    {
        id: 'builtin:conservative',
        name: 'Conservative',
        description: '0.5% risk per trade, 2% daily stop, few open trades and a high confidence bar.',
        values: {
            risk_per_trade: pct(0.5),
            daily_max_loss: pct(2),
            max_open_positions: 2,
            max_open_positions_total: 3,
            min_confidence: 8,
            loss_cooldown_bars: 6,
            scalp_max_per_day: 4,
        },
    },
    {
        id: 'builtin:balanced',
        name: 'Balanced',
        description: '1% risk per trade, 4% daily stop, up to 4 open trades per instrument.',
        values: {
            risk_per_trade: pct(1),
            daily_max_loss: pct(4),
            max_open_positions: 4,
            max_open_positions_total: 6,
            min_confidence: 7,
            loss_cooldown_bars: 3,
            scalp_max_per_day: 8,
        },
    },
    {
        id: 'builtin:aggressive',
        name: 'Aggressive',
        description: '2% risk per trade, 6% daily stop, more open trades and a lower confidence bar.',
        values: {
            risk_per_trade: pct(2),
            daily_max_loss: pct(6),
            max_open_positions: 6,
            max_open_positions_total: 10,
            min_confidence: 6,
            loss_cooldown_bars: 1,
            scalp_max_per_day: 16,
        },
    },
    {
        id: 'builtin:micro',
        name: 'Micro account',
        description: 'For accounts around $100: $10 risk (0.01 lot of gold), one open trade, $30 daily stop.',
        values: {
            risk_per_trade: usd(10),
            daily_max_loss: usd(30),
            max_open_positions: 1,
            max_open_positions_total: 1,
            min_confidence: 7,
            loss_cooldown_bars: 3,
            scalp_max_per_day: 5,
            max_lot: { XAUUSD: 0.01 },
        },
    },
];

/** limits match GoldAutomateService.setSettings, so a stored profile always applies */
const INT_FIELDS: Record<string, [number, number]> = {
    max_open_positions: [1, 20],
    max_open_positions_total: [0, 200],
    min_confidence: [0, 8],
    loss_cooldown_bars: [0, 100],
    scalp_max_per_day: [1, 50],
};
const AMOUNT_LIMITS: Record<'risk_per_trade' | 'daily_max_loss', Record<AmountUnit, [number, number]>> = {
    risk_per_trade: { usd: [1, 100_000], pct: [0.01, 10] },
    daily_max_loss: { usd: [0, 1_000_000], pct: [0, 50] },
};

/** validates a profile body coming from the dashboard; throws a 400 naming the first bad field */
export function parseProfileValues(raw: unknown): RiskProfileValues {
    const bad = (msg: string) => new BadRequestException(`values.${msg}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new BadRequestException('values must be an object');
    const r = raw as Record<string, any>;
    const amount = (k: 'risk_per_trade' | 'daily_max_loss'): Amount => {
        const a = r[k];
        if (!a || typeof a !== 'object') throw bad(`${k} must be { unit: 'usd' | 'pct', value }`);
        if (a.unit !== 'usd' && a.unit !== 'pct') throw bad(`${k}.unit must be usd or pct`);
        const [min, max] = AMOUNT_LIMITS[k][a.unit as AmountUnit];
        const v = Number(a.value);
        if (!Number.isFinite(v) || v < min || v > max) throw bad(`${k}.value must be ${min}–${max} (${a.unit})`);
        return { unit: a.unit, value: v };
    };
    const out: RiskProfileValues = {
        risk_per_trade: amount('risk_per_trade'),
        daily_max_loss: amount('daily_max_loss'),
    } as RiskProfileValues;
    for (const [k, [min, max]] of Object.entries(INT_FIELDS)) {
        const v = Number(r[k]);
        if (!Number.isInteger(v) || v < min || v > max) throw bad(`${k} must be a whole number ${min}–${max}`);
        (out as any)[k] = v;
    }
    if (r.max_lot != null) {
        if (typeof r.max_lot !== 'object' || Array.isArray(r.max_lot)) throw bad('max_lot must be an object');
        const lots: Partial<Record<ProfileInstrument, number>> = {};
        for (const [k, v] of Object.entries(r.max_lot)) {
            if (!(PROFILE_INSTRUMENTS as readonly string[]).includes(k)) throw bad(`max_lot.${k} is not an instrument`);
            if (v === null || v === undefined || v === '') continue;
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0.01 || n > 100) throw bad(`max_lot.${k} must be 0.01–100`);
            lots[k as ProfileInstrument] = n;
        }
        if (Object.keys(lots).length) out.max_lot = lots;
    }
    return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The setSettings body a profile becomes for an account balance. A % amount needs the balance;
 * without it the result is null and the profile cannot be applied right now.
 */
export function resolveProfile(values: RiskProfileValues, balance: number | null): Record<string, number> | null {
    const toUsd = (a: Amount, floor: number): number | null => {
        if (a.unit === 'usd') return a.value;
        if (balance == null || !(balance > 0)) return null;
        return Math.max(floor, round2((balance * a.value) / 100));
    };
    const risk = toUsd(values.risk_per_trade, 1);
    const daily = toUsd(values.daily_max_loss, 0);
    if (risk == null || daily == null) return null;
    const body: Record<string, number> = {
        risk_usd_per_trade: risk,
        daily_max_loss_usd: daily,
        max_open_positions: values.max_open_positions,
        max_open_positions_total: values.max_open_positions_total,
        min_confidence: values.min_confidence,
        loss_cooldown_bars: values.loss_cooldown_bars,
        scalp_max_per_day: values.scalp_max_per_day,
    };
    for (const [k, v] of Object.entries(values.max_lot ?? {})) body[`max_lot_${k.toLowerCase()}`] = v;
    return body;
}
