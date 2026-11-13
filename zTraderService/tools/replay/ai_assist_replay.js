/**
 * Re-asks the AI assist about archived range-break setups, with the inputs the live round had, and
 * passes each answer through the same gates as the live bot (applyAssist → validateDecision →
 * minimum confidence). Calls the real Gemini API: every run costs money and uses GEMINI_API_KEY.
 *
 *   npm run build:api
 *   node tools/replay/ai_assist_replay.js <setups.json> <variant> <strictness> <repeats> <out.jsonl> [id-substring]
 *
 * setups.json: one object per setup — { id, file (archive round), t, inst, mode, rrMin,
 *   openPositions (summary string as the live round built it), sizeCap, dailyPnlUsd }.
 * variant: "current" = the prompt and gates in dist/ · "v0" = the 10 Nov prompt (the range-break
 *   section removed again), to check the replay reproduces the live answers.
 * strictness: normal | strict | very_strict | maximum.
 *
 * Inputs the archive does not keep: the news headlines (sent empty — the same for every variant)
 * and the live tick (the archived bid/ask of the round stands in for it).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { GoldGeminiService } = require(path.join(ROOT, 'dist/gold/ai/gold-gemini.service'));
const { GoldAutomateService } = require(path.join(ROOT, 'dist/gold/gold-automate.service'));
const { INSTRUMENTS, fmtPrice } = require(path.join(ROOT, 'dist/gold/domain/instruments'));

const [setupsFile, variant, strictness, repeatsArg, outFile, only, newsFile] = process.argv.slice(2);
if (!setupsFile || !variant || !strictness || !outFile) {
    console.error('usage: ai_assist_replay.js <setups.json> <current|v0> <strictness> <repeats> <out.jsonl> [id-substring] [news.json]');
    process.exit(2);
}
const repeats = Math.max(1, parseInt(repeatsArg || '1', 10));
const CONCURRENCY = parseInt(process.env.REPLAY_CONCURRENCY || '4', 10);

// --- configuration: .env (key) + the dashboard settings file (model, thinking, min confidence) ---
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const settingsFile = path.join(ROOT, 'data/runtime-settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
const conf = { ...env, ...settings, GOLD_AI_STRICTNESS: strictness };
const configService = { get: (k, d) => (conf[k] !== undefined && conf[k] !== '' ? conf[k] : d) };
const MIN_CONFIDENCE = parseInt(conf.GOLD_MIN_CONFIDENCE || '7', 10);

const gemini = new GoldGeminiService(configService);
for (const k of ['GEMINI_MODEL', 'GOLD_AI_THINKING', 'GOLD_AI_TEMPERATURE', 'GOLD_AI_STRICTNESS']) {
    if (conf[k]) gemini.setRuntime(k, String(conf[k]));
}
let lastUsage = '';
gemini.logger = { log: (m) => (lastUsage = String(m)), warn: () => {}, error: (m) => console.error('  ai error:', m), debug: () => {} };

// --- the 10 Nov prompt: today's prompt with the range-break additions taken out again ---
if (variant === 'v0') {
    const build = gemini.buildSystemPrompt.bind(gemini);
    gemini.buildSystemPrompt = (profile, mode, ref) => {
        let s = build(profile, mode, ref);
        s = s.replace(/\n## Range breaks \(scalp #2 \/ intraday #2\)[\s\S]*?\n\n(?=## Instrument)/, '\n');
        s = s.replace(' · for sweep and pullback setups TP must stop at least', ' · TP must stop at least');
        s = s.replace(' before the next round number (range breaks: see above)', ' before the next round number');
        s = s.replace(
            /- Realistic sweep-scalp target \(scalp #1\): (.*?) · a range break \(scalp #2\) targets 1\.5R and may go further/,
            (_, r) => `- Realistic scalp target: ${r} · break-retest setup no more than ${fmtPrice(profile, profile.scalp.breakCap)}`,
        );
        if (/## Range breaks|range breaks: see above|a range break \(scalp #2\) targets/.test(s)) throw new Error('v0 transform left the 13 Nov additions in the prompt');
        return s;
    };
}

// --- the live gates, on a bare automate instance ---
const quiet = { log() {}, warn() {}, error() {}, debug() {} };
function automate() {
    const o = Object.create(GoldAutomateService.prototype);
    o.logger = quiet;
    o.overrides = new Map([['GOLD_AI_STRICTNESS', strictness]]);
    o.configService = configService;
    o.ticks = new Map();
    o.instruments = { active: INSTRUMENTS.XAUUSD };
    return o;
}
const withNow = (ms, fn) => {
    const real = Date.now;
    Date.now = () => ms;
    try {
        return fn();
    } finally {
        Date.now = real;
    }
};

async function one(s, rep, newsItems) {
    const round = JSON.parse(fs.readFileSync(path.join(ROOT, s.file), 'utf8'));
    const ctx = round.context || {};
    const ta = ctx.base_decision;
    const profile = INSTRUMENTS[s.inst];
    const t = Date.parse(s.t);
    const runtime = { rrMin: s.rrMin, openPositions: s.openPositions || '', sizeCap: s.sizeCap ?? null, dailyPnlUsd: s.dailyPnlUsd ?? null };
    const started = Date.now();
    lastUsage = '';
    // a control headline may carry {DATE}: the setup's own day, so the release is "today" for every setup
    const news = newsItems.map((n) => ({ ...n, title: n.title.replaceAll('{DATE}', s.t.slice(0, 10)), pubDate: n.pubDate.replaceAll('{DATE}', s.t.slice(0, 10)) }));
    const ai = await gemini.assist(s.mode, ta, round.series_tail, runtime, { profile, news, now: new Date(t) });
    const usage = lastUsage.match(/\(thinking (\d+) tok · in (\d+) · out (\d+)\)/);
    const o = automate();
    if (ctx.market?.bid) o.ticks.set(profile.key, { bid: ctx.market.bid, ask: ctx.market.ask, at: t });
    let gate;
    let final = null;
    if (!ai) gate = 'ai-unavailable (TA used as is)';
    withNow(t + 1000, () => {
        final = ai ? o.applyAssist(ta, ai, s.rrMin, profile) : ta;
        if (final.order_type === 'NO_TRADE') gate = gate ?? `no-trade: ${final.reason}`;
        else {
            const invalid = o.validateDecision(final, s.rrMin);
            if (invalid) gate = `rejected: ${invalid}`;
            else if (final.confidence < MIN_CONFIDENCE) gate = `skipped: confidence ${final.confidence} < ${MIN_CONFIDENCE}`;
            else gate = gate ?? 'trade';
        }
    });
    return {
        id: s.id,
        variant,
        strictness,
        rep,
        news: newsItems.length ? 'injected' : 'none',
        verdict: ai?.verdict ?? null,
        veto_reason: ai?.veto_reason ?? null,
        ai_confidence: ai?.confidence ?? null,
        ai_size: ai?.size ?? null,
        ai_levels: ai ? { entry: ai.entry, sl: ai.sl, tp1: ai.tp1 } : null,
        reason: ai?.reason ?? null,
        gate,
        final: final && final.order_type !== 'NO_TRADE'
            ? { order_type: final.order_type, entry: final.entry, sl: final.sl, tp1: final.tp1, size: final.size, confidence: final.confidence }
            : null,
        tokens: usage ? { thinking: +usage[1], in: +usage[2], out: +usage[3] } : null,
        ms: Date.now() - started,
    };
}

(async () => {
    const setups = JSON.parse(fs.readFileSync(setupsFile, 'utf8')).filter((s) => !only || s.id.includes(only));
    const newsItems = newsFile ? JSON.parse(fs.readFileSync(newsFile, 'utf8')) : [];
    const jobs = [];
    for (let rep = 1; rep <= repeats; rep++) for (const s of setups) jobs.push([s, rep]);
    const out = fs.createWriteStream(outFile, { flags: 'a' });
    let next = 0;
    let done = 0;
    async function worker() {
        while (next < jobs.length) {
            const [s, rep] = jobs[next++];
            try {
                const r = await one(s, rep, newsItems);
                out.write(JSON.stringify(r) + '\n');
                console.log(`${++done}/${jobs.length} ${r.id} r${rep}: ${r.verdict ?? '-'} c${r.ai_confidence ?? '-'} → ${r.gate.slice(0, 70)}`);
            } catch (e) {
                console.error(`${++done}/${jobs.length} ${s.id} r${rep}: FAILED ${e?.message ?? e}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    out.end();
})();
