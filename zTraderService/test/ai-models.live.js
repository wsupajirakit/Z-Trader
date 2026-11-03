/**
 * Live check: every Gemini model the dashboard can offer must really work with the app's own
 * request (system prompt, JSON schema, thinking level, parser) — not a mock.
 *
 * Calls the real Gemini API (costs tokens) and reads real bars from a running service, so it is
 * NOT part of `npm test`. Run it on purpose:
 *
 *   npm run build && node test/ai-models.live.js [--levels minimal,low,medium,high] [--mode swing]
 *
 * Needs GEMINI_API_KEY and API_KEY in .env and the service listening on PORT (default 6500).
 * Writes the full result to /tmp/ztrader-ai-models.json and exits 1 when any model fails.
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROJECT = path.resolve(__dirname, '..');
process.env.NODE_PATH = [path.join(PROJECT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();
if (fs.existsSync(path.join(PROJECT, '.env'))) process.loadEnvFile(path.join(PROJECT, '.env'));

const OUT = path.join(PROJECT, 'dist/gold');
const { GoldGeminiService, geminiCandidates } = require(path.join(OUT, 'ai/gold-gemini.service'));
const { GoldTaService } = require(path.join(OUT, 'analysis/gold-ta.service'));

const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
};
const LEVELS = arg('levels', 'minimal,low,medium,high').split(',');
const MODE = arg('mode', 'swing');
const PARALLEL = Number(arg('parallel', '3'));

const settingsFile = path.resolve(PROJECT, process.env.GOLD_SETTINGS_FILE || './data/runtime-settings.json');
const runtimeSettings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};

function service(model, level) {
    const env = { ...process.env, ...runtimeSettings, GEMINI_MODEL: model, GOLD_AI_THINKING: level };
    const svc = new GoldGeminiService({ get: (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d) });
    const logs = [];
    svc.logger = { log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERROR ${m}`) };
    return { svc, logs };
}

async function liveSeries() {
    const port = process.env.PORT || 6500;
    const res = await fetch(`http://127.0.0.1:${port}/gold/data?mode=${MODE}&bars=1000`, {
        headers: { 'x-api-key': process.env.API_KEY },
    });
    if (!res.ok) throw new Error(`/gold/data answered ${res.status}`);
    const body = await res.json();
    return Object.fromEntries(Object.entries(body.series).map(([k, v]) => [k, v.tail]));
}

/** the TA decision for these bars; a near-price BUY_LIMIT when TA has no setup, so assist() still runs */
function taDecision(series) {
    const d = new GoldTaService().analyze(MODE, series, { rrMin: 1.5, sizeCap: null });
    if (d.order_type !== 'NO_TRADE') return d;
    const bars = series.xauusd_1h ?? Object.values(series)[0];
    const last = bars[bars.length - 1];
    const atr = last.atr14;
    const entry = +(last.close - 0.3 * atr).toFixed(2);
    return {
        ...d,
        order_type: 'BUY_LIMIT',
        entry,
        sl: +(entry - 1.5 * atr).toFixed(2),
        tp1: +(entry + 3 * atr).toFixed(2),
        tp2: +(entry + 4.5 * atr).toFixed(2),
        rr_tp1: 2,
        confidence: 6,
        size: 'half',
        reason: 'test setup near the live price',
    };
}

async function one(kind, model, level, series, ta) {
    const { svc, logs } = service(model, level);
    const runtime = { rrMin: 1.5, openPositions: 'none', sizeCap: null, dailyPnlUsd: 0 };
    const started = Date.now();
    const out =
        kind === 'propose' ? await svc.propose(MODE, series, runtime) : await svc.assist(MODE, ta, series, runtime);
    const usage = logs.map((l) => /thinking (\d+) tok · in (\d+) · out (\d+)/.exec(l)).find(Boolean);
    return {
        kind,
        model,
        level,
        ok: out !== null,
        secs: +((Date.now() - started) / 1000).toFixed(1),
        result: out ? (kind === 'propose' ? out.action : out.verdict) : null,
        tokens: usage ? { thinking: +usage[1], in: +usage[2], out: +usage[3] } : null,
        problem: out ? null : logs.filter((l) => /^(WARN|ERROR)/.test(l)).join(' | ').slice(0, 300) || 'no answer',
    };
}

async function pool(jobs, n) {
    const results = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: n }, async () => {
            while (next < jobs.length) {
                const job = jobs[next++];
                const r = await job();
                results.push(r);
                console.log(`${r.ok ? '✓' : '✗'} ${r.kind.padEnd(7)} ${r.model.padEnd(28)} ${r.level.padEnd(7)} ${String(r.secs).padStart(6)}s ${r.result ?? r.problem}`);
            }
        }),
    );
    return results;
}

(async () => {
    const { svc } = service('gemini-3.5-flash', 'low');
    const all = await geminiCandidates(svc.apiKey);
    const offered = await svc.listModels();
    console.log(`Gemini models usable for trading (live ListModels): ${all.map((m) => m.id).join(', ')}`);
    console.log(`Dashboard offers: ${offered.map((m) => m.id).join(', ')}`);
    const hidden = all.filter((m) => !offered.some((o) => o.id === m.id)).map((m) => m.id);
    if (hidden.length) console.log(`NOT offered by the dashboard: ${hidden.join(', ')}`);

    const series = await liveSeries();
    const ta = taDecision(series);
    console.log(`Live ${MODE} bars: ${Object.keys(series).join(', ')} · TA ${ta.order_type} @ ${ta.entry}\n`);

    const jobs = [];
    for (const m of all) {
        for (const level of LEVELS) jobs.push(() => one('propose', m.id, level, series, ta));
        jobs.push(() => one('assist', m.id, runtimeSettings.GOLD_AI_THINKING || 'low', series, ta));
    }
    const results = await pool(jobs, PARALLEL);
    fs.writeFileSync('/tmp/ztrader-ai-models.json', JSON.stringify({ at: new Date().toISOString(), hidden, results }, null, 2));
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} calls passed · full result in /tmp/ztrader-ai-models.json`);
    process.exit(failed.length || hidden.length ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(2);
});
