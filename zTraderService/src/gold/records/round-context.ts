import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * What every analysis round records about the configuration it ran under, so any trade can be traced
 * back to its exact settings and any round can be replayed in a backtest. Stored in the archive file
 * of the round (`context`) and, for rounds that place an order, on the order record in MongoDB.
 *
 * Bump ROUND_CONTEXT_SCHEMA when a field changes meaning; readers branch on it.
 */
export const ROUND_CONTEXT_SCHEMA = 1;

export interface ConfigSnapshot {
    app: { version: string; commit: string | null };
    account_mode: string;
    instrument: { key: string; symbol_id: number | null; digits: number; pip: number; units_per_lot: number };
    mode: { name: string; rr_min: number; period_min: number; tradable_modes: string[] };
    engine: 'ta' | 'ai';
    data_source: string;
    /** last applied risk profile and whether the settings were edited by hand since */
    risk_profile: { id: string; name: string; modified: boolean; changed: string[] } | null;
    risk: {
        sizing: string;
        risk_usd_per_trade: number;
        base_lot: number;
        daily_max_loss_usd: number;
        max_open_positions: number;
        max_open_positions_total: number;
        min_confidence: number;
        loss_cooldown_bars: number;
        scalp_max_per_day: number;
        max_lot: number;
        risk_tolerance: number;
    };
    ai: {
        mode_selected: string;
        mode_effective: string;
        provider: string;
        model: string;
        thinking: string;
        strictness: string;
        strictness_min_confidence: number | null;
        gate: string;
        temperature: number;
        max_calls_per_day: number;
    };
    /** every setting changed from the dashboard (env names → value); never contains credentials */
    overrides: Record<string, string>;
}

export interface RoundSizing {
    method: string;
    size: string;
    size_cap: string | null;
    effective_size: string;
    sl_distance: number;
    risk_usd: number | null;
    usd_per_unit_per_lot: number | null;
    raw_lots: number;
    max_lot: number;
    lots: number;
}

export interface RoundTrace {
    schema: number;
    config_hash: string;
    config: ConfigSnapshot;
    /** what each guard saw this round (filled as the round goes; missing = the round stopped earlier) */
    guards: {
        open_positions?: number;
        open_positions_total?: number;
        daily_pnl_usd?: number | null;
        last_loss_close_utc?: string | null;
        size_cap?: string | null;
        ai_mode_this_round?: string;
    };
    /** the TA (or Claude engine) decision before any AI layer changed it */
    base_decision: unknown;
    /** the AI's raw answer this round (assist verdict or proposal), if it was asked */
    ai_answer: unknown;
    market: { bid: number; ask: number; spread: number; tick_age_ms: number } | null;
    sizing: RoundSizing | null;
}

/** never let a credential into a record, whatever the settings map holds */
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|PASS\b/i;

export function withoutSecrets(map: Iterable<[string, string]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of map) if (!SECRET_KEY.test(k)) out[k] = v;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** JSON with sorted keys, so equal configurations always hash the same */
function stableStringify(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(v ?? null);
}

/**
 * Short id of a configuration, to group trades that ran under identical settings. The app version and
 * the risk-profile "modified" bookkeeping are left out: they do not change how the bot decides.
 */
export function configHash(c: ConfigSnapshot): string {
    const material: Record<string, unknown> = { ...c, risk_profile_id: c.risk_profile?.id ?? null };
    delete material.app;
    delete material.risk_profile;
    return createHash('sha256').update(stableStringify(material)).digest('hex').slice(0, 12);
}

export function newTrace(config: ConfigSnapshot): RoundTrace {
    return {
        schema: ROUND_CONTEXT_SCHEMA,
        config_hash: configHash(config),
        config,
        guards: {},
        base_decision: null,
        ai_answer: null,
        market: null,
        sizing: null,
    };
}

let cachedVersion: { version: string; commit: string | null } | null = null;

/** package version and, when the image was built with it, the git commit (APP_COMMIT) */
export function appVersion(): { version: string; commit: string | null } {
    if (!cachedVersion) {
        let version = 'unknown';
        try {
            version =
                (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string })
                    .version ?? 'unknown';
        } catch {
            /* running from an unusual cwd: version stays unknown */
        }
        cachedVersion = { version, commit: process.env.APP_COMMIT?.trim() || null };
    }
    return cachedVersion;
}
