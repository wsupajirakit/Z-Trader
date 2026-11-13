/**
 * How the AI's answer on a range break (scalp #2 / intraday #2) is used, and that every AI prompt
 * carries the range-break rules at every strictness level (docs/breakout-entry.md):
 *   - the rules block is in the assist, lead / AI only and Claude-engine system prompts, after the
 *     strictness line, for normal / strict / very_strict / maximum
 *   - a range break is dropped only for a hard veto (major_news, data_error); any other doubt makes
 *     it smaller (half; quarter at very strict / maximum); its measured levels and TA confidence stay
 *   - a CONFIRM at exactly the minimum R:R is not rejected by price rounding (any playbook)
 *   - swing #2 / position #2 are pullbacks, not range breaks
 *
 * Uses dist/ (no broker, no network): npm run build:api && node --test test/ai-range-break.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const { GoldAutomateService } = require(path.join(DIST, 'gold/gold-automate.service'));
const { GoldGeminiService } = require(path.join(DIST, 'gold/ai/gold-gemini.service'));
const { GoldAiService } = require(path.join(DIST, 'gold/ai/gold-ai.service'));
const { INSTRUMENTS } = require(path.join(DIST, 'gold/domain/instruments'));
const { isRangeBreak, RANGE_BREAK_REVIEWER_RULES, RANGE_BREAK_ANALYST_RULES } = require(path.join(DIST, 'gold/ai/range-break-rules'));
const { AI_STRICTNESS_LEVELS, STRICTNESS_INSTRUCTION } = require(path.join(DIST, 'gold/ai/ai-strictness'));

const EUR = INSTRUMENTS.EURUSD;
const quiet = { log() {}, warn() {}, error() {}, debug() {} };
const cfgOf = (over) => ({ get: (k, d) => (over[k] !== undefined ? over[k] : d) });

function auto(strictness, minConfidence = '6') {
    const o = Object.create(GoldAutomateService.prototype);
    o.logger = quiet;
    o.overrides = new Map([
        ['GOLD_AI_STRICTNESS', strictness],
        ['GOLD_MIN_CONFIDENCE', minConfidence],
    ]);
    o.configService = cfgOf({});
    o.ticks = new Map();
    o.instruments = { active: EUR };
    return o;
}

// an intraday #2 SELL STOP exactly at the 1.8 minimum R:R after price rounding (as on 11 Nov)
const TA = {
    order_type: 'SELL_STOP',
    entry: 1.1147,
    sl: 1.1165,
    tp1: 1.11146,
    tp2: 1.10979,
    rr_tp1: 1.8,
    confidence: 9,
    size: 'full',
    valid_until_utc: null,
    invalidation: '',
    playbook_ref: 'intraday #2',
    reason: '15m bar closed through the range',
    analysis_summary: '',
};
const ai = (o = {}) => ({
    verdict: 'CONFIRM',
    entry: null,
    sl: null,
    tp1: null,
    tp2: null,
    size: 'full',
    confidence: 8,
    key_levels: '',
    risk_note: '',
    reason: 'r',
    veto_reason: 'none',
    ...o,
});

test('isRangeBreak: scalp #2 and intraday #2 only', () => {
    assert.equal(isRangeBreak('scalp #2'), true);
    assert.equal(isRangeBreak('intraday #2'), true);
    for (const ref of ['swing #2', 'position #2', 'scalp #1', 'intraday #5', '', null]) assert.equal(isRangeBreak(ref), false, String(ref));
});

test('a hard veto (major_news, data_error) cancels a range break at every strictness', () => {
    for (const s of AI_STRICTNESS_LEVELS) {
        for (const why of ['major_news', 'data_error']) {
            const d = auto(s).applyAssist(TA, ai({ verdict: 'VETO', veto_reason: why, confidence: 2 }), 1.8, EUR);
            assert.equal(d.order_type, 'NO_TRADE', `${s} ${why}`);
            assert.match(d.reason, new RegExp(`AI veto \\(${why}\\)`));
        }
    }
});

test('any other veto keeps the trade at the measured levels, smaller: half, quarter at very strict / maximum', () => {
    const want = { normal: 'half', strict: 'half', very_strict: 'quarter', maximum: 'quarter' };
    for (const s of AI_STRICTNESS_LEVELS) {
        for (const why of ['levels', 'late_entry', 'structure', 'exposure', 'companions', 'other', undefined]) {
            const d = auto(s).applyAssist(TA, ai({ verdict: 'VETO', veto_reason: why, confidence: 3 }), 1.8, EUR);
            assert.equal(d.order_type, 'SELL_STOP', `${s} ${why}`);
            assert.deepEqual([d.entry, d.sl, d.tp1], [TA.entry, TA.sl, TA.tp1]);
            assert.equal(d.size, want[s], `${s} ${why}`);
            assert.equal(d.confidence, TA.confidence, 'the TA confidence stays, so the global minimum does not drop it');
            assert.match(d.reason, /is not a cancel reason for a range break/);
        }
    }
});

test('low AI confidence makes a range break smaller instead of cancelling it (strictness thresholds included)', () => {
    const strict = auto('strict').applyAssist(TA, ai({ confidence: 5 }), 1.8, EUR); // below strict 6
    assert.equal(strict.order_type, 'SELL_STOP');
    assert.equal(strict.size, 'half');
    const max = auto('maximum').applyAssist(TA, ai({ confidence: 7 }), 1.8, EUR); // below maximum 8
    assert.equal(max.order_type, 'SELL_STOP');
    assert.equal(max.size, 'quarter');
    const sure = auto('maximum').applyAssist(TA, ai({ confidence: 9 }), 1.8, EUR);
    assert.equal(sure.size, 'full');
    assert.match(sure.reason, /AI confirmed \(9\/10\)/);
});

test('ADJUST on a range break: the measured levels stay; a smaller size from the AI is kept', () => {
    const d = auto('normal').applyAssist(TA, ai({ verdict: 'ADJUST', entry: 1.1144, sl: 1.1159, tp1: 1.1131, size: 'half' }), 1.8, EUR);
    assert.equal(d.order_type, 'SELL_STOP');
    assert.deepEqual([d.entry, d.sl, d.tp1], [TA.entry, TA.sl, TA.tp1]);
    assert.equal(d.size, 'half');
});

test('price rounding no longer rejects a CONFIRM at exactly the minimum R:R (any playbook)', () => {
    const swing = { ...TA, playbook_ref: 'swing #1', order_type: 'SELL_LIMIT' };
    const d = auto('normal').applyAssist(swing, ai({ verdict: 'CONFIRM' }), 1.8, EUR);
    assert.equal(d.order_type, 'SELL_LIMIT', d.reason);
    // a moved level that really falls short is still refused
    const short = auto('normal').applyAssist(swing, ai({ verdict: 'ADJUST', tp1: 1.1125 }), 1.8, EUR);
    assert.equal(short.order_type, 'NO_TRADE');
    assert.match(short.reason, /After the AI adjustment R:R/);
});

test('a non-range-break setup keeps the old veto and strictness behaviour', () => {
    const swing = { ...TA, playbook_ref: 'swing #2', order_type: 'SELL_LIMIT' };
    assert.equal(auto('normal').applyAssist(swing, ai({ verdict: 'VETO', veto_reason: 'levels' }), 1.8, EUR).order_type, 'NO_TRADE');
    assert.equal(auto('strict').applyAssist(swing, ai({ confidence: 5 }), 1.8, EUR).order_type, 'NO_TRADE');
});

test('every AI prompt carries the range-break rules at every strictness level, after the strictness line', () => {
    for (const s of AI_STRICTNESS_LEVELS) {
        const g = new GoldGeminiService(cfgOf({ GOLD_AI_STRICTNESS: s }));
        const c = new GoldAiService(cfgOf({ GOLD_AI_STRICTNESS: s }));
        const prompts = {
            assist: [g.assistSystemInstruction(EUR, 'intraday', 1.11), RANGE_BREAK_REVIEWER_RULES],
            lead: [g.leadSystemInstruction(EUR, 'scalp', 1.11), RANGE_BREAK_ANALYST_RULES],
            claude: [c.systemPrompt(EUR), RANGE_BREAK_ANALYST_RULES],
        };
        for (const [name, [text, rules]] of Object.entries(prompts)) {
            assert.ok(text.endsWith(rules), `${s} ${name}: the rules are the last block`);
            const line = STRICTNESS_INSTRUCTION[s];
            if (line) assert.ok(text.indexOf(line) < text.indexOf(rules), `${s} ${name}: rules come after the strictness line`);
        }
    }
});
