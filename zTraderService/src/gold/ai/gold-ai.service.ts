import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { GoldExport } from '../data/gold-data.service';
import { InstrumentProfile, XAUUSD_PROFILE } from '../domain/instruments';
import { errorMessage } from '../../common/utils/errors';
import { AI_STRICTNESS_LEVELS, type AiStrictness, STRICTNESS_INSTRUCTION } from './ai-strictness';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

export type GoldOrderType = 'BUY_LIMIT' | 'BUY_STOP' | 'SELL_LIMIT' | 'SELL_STOP' | 'NO_TRADE';
export type GoldSize = 'quarter' | 'half' | 'full';

/** JSON contract with the AI — mirrors XAU_AUTOMATE.md §6 */
export interface GoldDecision {
    order_type: GoldOrderType;
    entry: number | null;
    sl: number | null;
    tp1: number | null;
    tp2: number | null;
    rr_tp1: number | null;
    confidence: number; // 0-10
    size: GoldSize;
    valid_until_utc: string | null;
    invalidation: string;
    playbook_ref: string;
    reason: string;
    analysis_summary: string;
    /** ความเห็นจาก AI assist (Gemini) ถ้าเปิดใช้ — undefined = ตัดสินด้วย TA ล้วน */
    ai_assist?: import('./gold-gemini.service').GoldAiAssist;
    /**
     * NO_TRADE นี้ "เฉียด" ไหม — โครงสร้างมีอยู่แต่ตกเกณฑ์เชิงปริมาณข้อเดียว
     * ใช้เป็นประตูว่าจะถาม AI ต่อหรือไม่ (ดู NEAR_MISS_RULES ใน gold-ta.service.ts)
     * undefined/false = ไม่มีโครงสร้างเลย ถาม AI ไปก็เสียเปล่า
     */
    near_miss?: boolean;
    /** id ของกฎที่ทำให้ถือว่าเฉียด — ไว้ดูสถิติว่ากฎไหนคุ้มค่าถาม AI */
    near_miss_rule?: string;
}

const DECISION_SCHEMA = {
    type: 'object',
    properties: {
        order_type: { type: 'string', enum: ['BUY_LIMIT', 'BUY_STOP', 'SELL_LIMIT', 'SELL_STOP', 'NO_TRADE'] },
        entry: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Entry price. null when NO_TRADE' },
        sl: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Stop loss price. null when NO_TRADE' },
        tp1: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Take profit 1. null when NO_TRADE' },
        tp2: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Take profit 2. null when NO_TRADE' },
        rr_tp1: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description: 'Risk:Reward at TP1. null when NO_TRADE',
        },
        confidence: { type: 'integer', description: 'Conviction 0-10' },
        size: { type: 'string', enum: ['quarter', 'half', 'full'] },
        valid_until_utc: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description:
                'ISO-8601 UTC time when the pending order should expire, e.g. 2026-08-04T12:00:00Z. null when NO_TRADE',
        },
        invalidation: { type: 'string', description: 'Condition that invalidates the setup (in English)' },
        playbook_ref: {
            type: 'string',
            description:
                'ENTRY_PLAYBOOK item(s) this setup references, e.g. "swing #1". Required for any trade — empty means NO_TRADE',
        },
        reason: { type: 'string', description: 'One-line reason (in English)' },
        analysis_summary: {
            type: 'string',
            description:
                'Concise English summary of the full ANALYSIS_REQUEST outputs: bias per TF, net companion read, upcoming news risk, plan A/B. Max ~15 lines.',
        },
    },
    required: [
        'order_type',
        'entry',
        'sl',
        'tp1',
        'tp2',
        'rr_tp1',
        'confidence',
        'size',
        'valid_until_utc',
        'invalidation',
        'playbook_ref',
        'reason',
        'analysis_summary',
    ],
    additionalProperties: false,
} as const;

/** system prompt ปรับตามตราสาร — ทอง = ข้อความเดิม, คู่เงินใส่ชื่อ/เลขกลม/ความรู้ของคู่นั้นแทน */
const SYSTEM_PROMPT_FOR = (
    p: InstrumentProfile,
) => `You are an elite multi-strategy institutional fund manager running a live ${p.key} (${p.kind === 'metal' ? 'spot gold' : 'spot forex, ' + p.name_th}) trading book on IC Markets via cTrader. You receive a data package exported from the operator's market-data service: gold_formula.csv (the analysis brief: ANALYSIS_REQUEST, ENTRY_PLAYBOOK, SESSION_MAP, READING_GUIDE, LATEST_FINANCIAL_NEWS) plus OHLCV+indicator CSVs for ${p.key} on several timeframes and companion instruments (${p.companions.map((c) => c.sym.toUpperCase()).join(', ')}).
Instrument facts: prices have ${p.digits} decimals · 1 pip = ${p.pip} · 1 lot = ${p.unitsPerLot.toLocaleString('en-US')} units (quote ${p.quoteCcy}) · typical daily range ${p.typicalDailyRange_th} · round-number magnets: ${p.round.label_th}.
Desk knowledge: ${p.brief.persona_th}
- Drivers: ${p.brief.drivers_th.join(' | ')}
- Behaviour: ${p.brief.behaviour_th.join(' | ')}
- Risks: ${p.brief.risks_th.join(' | ')}

Rules you must follow strictly:
- Work through every section of ANALYSIS_REQUEST in gold_formula.csv before deciding.
- Price CSVs: the first 5 lines starting with '#' are metadata. A row with Is_Closed_Bar=False is the live, unfinished bar — use it ONLY as current price, never to confirm signals or compute indicators.
- Volume is CFD tick volume — read CMF/OBV/RVOL comparatively only.
- Any trade MUST reference at least one ENTRY_PLAYBOOK setup for the current mode. No playbook match = NO_TRADE.
- Respect the mode's minimum R:R at TP1 (given in the runtime context). Below minimum = NO_TRADE.
- Order type semantics: BUY LIMIT = buy below current price (pullback), BUY STOP = buy above (breakout), SELL LIMIT = sell above (fade), SELL STOP = sell below (breakdown).
- Place SL away from round numbers (${p.round.label_th}) and beyond structure, per the mode's sl_guide. All prices in your answer must use ${p.digits} decimals.
- If companion data listed as missing materially weakens the read (e.g. DXY absent), lower size or output NO_TRADE.
- When in doubt, NO_TRADE. Capital preservation beats forced trades.
- Write every free-text field (reason, invalidation, analysis_summary) in English.

Your entire response is consumed by a bot — output only the JSON object required by the schema.`;

@Injectable()
export class GoldAiService {
    private readonly logger = new Logger(GoldAiService.name);
    private client: Anthropic | null = null;

    constructor(private configService: ConfigService) {}

    private getClient(): Anthropic {
        if (!this.client) {
            const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
            if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
            this.client = new Anthropic({ apiKey });
        }
        return this.client;
    }

    /**
     * Dashboard settings for this engine, set by GoldAutomateService (it owns the persisted overrides,
     * this service reads ConfigService directly and would not see them otherwise).
     */
    private runtime = new Map<string, string>();

    setRuntime(key: string, value: string) {
        this.runtime.set(key, value);
    }

    private cfg(key: string, fallback = ''): string {
        return this.runtime.get(key) ?? this.configService.get<string>(key, fallback) ?? fallback;
    }

    get hasKey(): boolean {
        return !!(this.configService.get<string>('ANTHROPIC_API_KEY') ?? '').trim();
    }

    /** GOLD_CLAUDE_MODEL first, then GOLD_AI_MODEL when it names a Claude model, else the current default */
    get model(): string {
        const explicit = this.cfg('GOLD_CLAUDE_MODEL').trim();
        if (explicit) return explicit;
        const shared = this.cfg('GOLD_AI_MODEL').trim();
        return /^claude/i.test(shared) ? shared : DEFAULT_CLAUDE_MODEL;
    }

    /** dashboard "intelligence" (GOLD_AI_THINKING) mapped onto Claude's effort levels */
    get effort(): 'low' | 'medium' | 'high' | 'xhigh' {
        const level = this.cfg('GOLD_AI_THINKING', 'high').toLowerCase().trim();
        return ({ minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh' } as const)[level as 'low'] ?? 'xhigh';
    }

    get strictness(): AiStrictness {
        const v = this.cfg('GOLD_AI_STRICTNESS', 'normal').toLowerCase().trim();
        return (AI_STRICTNESS_LEVELS as readonly string[]).includes(v) ? (v as AiStrictness) : 'normal';
    }

    private modelsCache: { at: number; list: Array<{ id: string; label: string }> } | null = null;

    /** Claude models available to this API key (Models API, cached 1 h); empty without a key */
    async listModels(): Promise<Array<{ id: string; label: string }>> {
        if (!this.hasKey) return [];
        if (this.modelsCache && Date.now() - this.modelsCache.at < 3_600_000) return this.modelsCache.list;
        const list: Array<{ id: string; label: string; created: string }> = [];
        for await (const m of this.getClient().models.list()) {
            if (m.id.startsWith('claude-'))
                list.push({ id: m.id, label: m.display_name, created: String(m.created_at) });
        }
        list.sort((a, b) => b.created.localeCompare(a.created));
        const out = list.slice(0, 8).map(({ id, label }) => ({ id, label }));
        this.modelsCache = { at: Date.now(), list: out };
        return out;
    }

    async analyze(
        data: GoldExport,
        runtime: { rrMin: number; openPositions: string; sizeCap: GoldSize | null },
        profile: InstrumentProfile = XAUUSD_PROFILE,
    ): Promise<GoldDecision> {
        // GOLD_AI_MODEL ถูกใช้ร่วมกับ Gemini assist แล้ว — engine Claude ใช้ GOLD_CLAUDE_MODEL ก่อน ถ้าไม่มีค่อย fallback
        const model = this.model;
        const now = new Date();

        const parts: string[] = [];
        parts.push(`## Runtime context
- mode: ${data.mode} (minimum R:R at TP1 = ${runtime.rrMin})
- now UTC: ${now.toISOString()} | Bangkok: ${now.toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' })} | New York: ${now.toLocaleString('en-GB', { timeZone: 'America/New_York' })}
- instrument: ${profile.key} (${profile.name_th})
- current open ${profile.key} positions: ${runtime.openPositions || 'none'}
- size cap imposed by risk guard: ${runtime.sizeCap ?? 'none (full allowed)'}`);

        if (data.errors) {
            parts.push(`## _errors.txt (companion fetch failures — factor into confidence/size)\n${data.errors}`);
        }

        parts.push(`## gold_formula.csv\n${data.formula}`);

        for (const [name, content] of data.files) {
            if (name === 'gold_formula.csv' || name === '_errors.txt') continue;
            parts.push(`## ${name}\n${content}`);
        }

        parts.push('Analyze per ANALYSIS_REQUEST and return the trading decision as JSON.');

        // adaptive thinking is always on for current Claude models; depth is set with effort (dashboard
        // "intelligence"), strictness is an extra system instruction. A safety decline is re-run on the
        // fallback model server-side (fallbacks: 'default'), and a refusal of the whole chain is NO_TRADE below.
        const strict = STRICTNESS_INSTRUCTION[this.strictness];
        const stream = this.getClient().beta.messages.stream({
            model,
            max_tokens: 64000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: strict ? `${SYSTEM_PROMPT_FOR(profile)}\n\n${strict}` : SYSTEM_PROMPT_FOR(profile),
            thinking: { type: 'adaptive' },
            output_config: {
                effort: this.effort,
                format: { type: 'json_schema', schema: DECISION_SCHEMA as any },
            },
            messages: [{ role: 'user', content: parts.join('\n\n') }],
        } as any);

        const message = await stream.finalMessage();

        if (message.stop_reason === 'refusal') {
            this.logger.warn('AI refused the request — treating as NO_TRADE');
            return this.noTrade('AI refusal (safety classifier)');
        }
        if (message.stop_reason === 'max_tokens') {
            this.logger.warn('AI output truncated at max_tokens — treating as NO_TRADE');
            return this.noTrade('AI output truncated');
        }

        const text = message.content.find((b: any) => b.type === 'text') as any;
        if (!text?.text) return this.noTrade('AI returned no text content');

        let decision: GoldDecision;
        try {
            decision = JSON.parse(text.text);
        } catch (e) {
            this.logger.error(`Failed to parse AI JSON: ${errorMessage(e)}`);
            return this.noTrade('AI JSON parse failure');
        }

        this.logger.log(
            `[${data.mode}] AI decision: ${decision.order_type} @ ${decision.entry} SL ${decision.sl} TP1 ${decision.tp1} ` +
                `RR ${decision.rr_tp1} conf ${decision.confidence} size ${decision.size} (${decision.playbook_ref || 'no playbook'})`,
        );
        return decision;
    }

    private noTrade(reason: string): GoldDecision {
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
            analysis_summary: reason,
        };
    }
}
