/**
 * Offline shape test for GoldGeminiService (no API key, no network).
 * Run: node test/gemini-shape.test.js  (ต้อง npm run build ก่อน — ใช้ dist/gold)
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

// run from the repo root (cd <repo> && node <this file>) or set ZTRADER_ROOT=<repo>
const PROJECT = path.resolve(process.env.ZTRADER_ROOT || path.join(__dirname, '..'));
if (!fs.existsSync(path.join(PROJECT, 'package.json'))) { console.error('run from the repo root or set ZTRADER_ROOT'); process.exit(2); }
process.env.NODE_PATH = [path.join(PROJECT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const candidates = [path.join(PROJECT, 'dist/gold')];
// a usable build must have the new instruments module too (a stale dist/ from before the profile refactor does not)
const OUT = candidates.find((d) => ['ai/gold-gemini.service.js', 'domain/instruments.js', 'domain/indicators.js'].every((f) => fs.existsSync(path.join(d, f))));
if (!OUT) { console.error('no compiled gold-gemini.service.js found in', candidates); process.exit(2); }
console.log('using build:', path.relative(PROJECT, OUT) || OUT);

const { GoldGeminiService } = require(path.join(OUT, 'ai/gold-gemini.service'));
const { enrich } = require(path.join(OUT, 'domain/indicators'));
const { XAUUSD_PROFILE, EURUSD_PROFILE, USDJPY_PROFILE, GOLD_MODES: _gm } = require(path.join(OUT, 'domain/instruments'));
const { GoogleGenAI, ThinkingLevel } = require('@google/genai');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
};

// ---------- fixtures ----------
const env = {
    GEMINI_API_KEY: 'fake-key-for-shape-test',
    GOLD_AI_THINKING: 'high',
};
const cfgSvc = { get: (k, d) => (env[k] !== undefined ? env[k] : d) };

function bars(n, tfMs, base, step, now) {
    const out = [];
    let px = base;
    const start = now - (n - 1) * tfMs;   // last bar opens < tfMs ago → unfinished
    for (let i = 0; i < n; i++) {
        const drift = Math.sin(i / 7) * step * 3 + (i % 5 - 2) * step;
        const o = px, c = px + drift, h = Math.max(o, c) + step, l = Math.min(o, c) - step;
        out.push({ ts: start + i * tfMs, open: o, high: h, low: l, close: c, volume: 100 + (i % 13) * 10 });
        px = c;
    }
    return out;
}
const NOW = Date.UTC(2026, 7, 24, 13, 7, 0); // Mon 2026-08-24 13:07 UTC = 09:07 ET (overlap window, after blackout)
const series = {
    xauusd_5m: enrich(bars(300, 5 * 60000, 4000, 0.8, NOW)),
    xauusd_15m: enrich(bars(250, 15 * 60000, 4000, 1.5, NOW)),
    xauusd_1d: enrich(bars(120, 86400000, 3900, 12, NOW)),
    dxy_15m: enrich(bars(250, 15 * 60000, 103.5, 0.03, NOW)),
    us10y_15m: enrich(bars(250, 15 * 60000, 4.25, 0.004, NOW)),
    usdjpy_15m: enrich(bars(250, 15 * 60000, 147.2, 0.05, NOW)),
};
const TA = {
    order_type: 'BUY_LIMIT', entry: 4001.5, sl: 3989.2, tp1: 4019.8, tp2: 4035, rr_tp1: 1.49,
    confidence: 7, size: 'full', valid_until_utc: '2026-08-24T14:00:00Z',
    invalidation: 'หลุด 3985 = ยกเลิก', playbook_ref: 'scalp #1', reason: 'sweep low 5m แล้วดีดกลับ',
    analysis_summary_th: Array.from({ length: 16 }, (_, i) => `บรรทัด ${i + 1} ของสรุป`).join('\n'),
};
const runtime = { rrMin: 1.5, openPositions: 'ไม่มี', sizeCap: null, dailyPnlUsd: -42.5 };
const news = [
    { source: 'CNBC', title: 'Stocks rally', pubDate: '2026-08-24T10:00:00Z' },
    { source: 'Investing.com', title: 'Gold slips as dollar firms ahead of Fed', pubDate: '2026-08-24T11:00:00Z', relevant: true },
];
const validAssist = {
    verdict: 'ADJUST', entry: 4002, sl: 3988.5, tp1: null, tp2: null, size: 'half', confidence: 7,
    key_levels: '4000 / 3989 swing low', risk_note_th: 'ใกล้เลขกลม 4000', reason_th: 'ขยับ SL ลงใต้ swing',
    news_risk_th: 'Fed พุธ', invalidation_th: 'ปิด 5m ใต้ 3985',
};

// ---------- service + captured client ----------
function makeService(reply, usage) {
    const svc = new GoldGeminiService(cfgSvc);
    svc.logger = { log: (m) => logs.push(['log', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) };
    const client = new GoogleGenAI({ apiKey: 'fake-key-for-shape-test' });
    t('real GoogleGenAI client exposes models.generateContent', typeof client.models.generateContent === 'function');
    client.models.generateContent = async (args) => {
        captured.push(args);
        return {
            text: typeof reply === 'function' ? reply() : reply,
            usageMetadata: usage || { thoughtsTokenCount: 321, promptTokenCount: 5000, candidatesTokenCount: 180 },
            candidates: [{ finishReason: 'STOP' }],
        };
    };
    svc.client = client;
    return svc;
}
let captured = [], logs = [];

(async () => {
    console.log('\nconfig getter:');
    const cfg = new GoldGeminiService(cfgSvc).config;
    t('keys intact + api', ['model', 'thinking_level', 'thinking', 'temperature', 'top_k', 'top_p', 'max_tokens', 'timeout_ms', 'has_key', 'api'].every((k) => k in cfg), JSON.stringify(cfg));
    t('defaults', cfg.model === 'gemini-3.5-flash' && cfg.thinking_level === 'high' && cfg.temperature === 0.2 && cfg.top_k === 40 && cfg.top_p === 0.95 && cfg.max_tokens === 16384 && cfg.timeout_ms === 180000 && cfg.has_key === true && cfg.api === 'generateContent');

    console.log('\nrequest shape (XAUUSD scalp):');
    captured = []; logs = [];
    let svc = makeService(JSON.stringify(validAssist));
    const out = await svc.assist('scalp', TA, series, runtime, { profile: XAUUSD_PROFILE, news, now: new Date(NOW) });
    t('generateContent called once', captured.length === 1);
    const req = captured[0] || {};
    const c = req.config || {};
    t('model from config', req.model === 'gemini-3.5-flash');
    t('contents is the user prompt string', typeof req.contents === 'string' && req.contents.length > 1000);
    t('systemInstruction non-empty string', typeof c.systemInstruction === 'string' && c.systemInstruction.length > 500);
    const pb = XAUUSD_PROFILE.modes.scalp.playbook;
    t('systemInstruction contains every scalp playbook line numbered "scalp #n"',
        pb.every((p, i) => c.systemInstruction.includes(`scalp #${i + 1}: ${p}`)));
    t('systemInstruction contains persona + role', c.systemInstruction.startsWith(XAUUSD_PROFILE.brief.persona_th) && c.systemInstruction.includes('ผู้ช่วยตรวจไม้'));
    t('systemInstruction has pip value $10/lot at entry', c.systemInstruction.includes('ขยับ 1 pip = 10.00 USD/lot'));
    t('responseJsonSchema set with anyOf nullable numbers', c.responseJsonSchema && c.responseJsonSchema.type === 'object'
        && Array.isArray(c.responseJsonSchema.properties.entry.anyOf) && c.responseJsonSchema.required.includes('news_risk_th') && c.responseJsonSchema.required.includes('invalidation_th'));
    t('responseMimeType application/json', c.responseMimeType === 'application/json');
    t('thinkingConfig.thinkingLevel === ThinkingLevel.HIGH', c.thinkingConfig && c.thinkingConfig.thinkingLevel === ThinkingLevel.HIGH && c.thinkingConfig.thinkingLevel === 'HIGH');
    t('temperature/topK/topP/maxOutputTokens present', c.temperature === 0.2 && c.topK === 40 && c.topP === 0.95 && c.maxOutputTokens === 16384);
    t('no Interactions-API keys leaked (generation_config/top_k/thinking_level)', !('generation_config' in req) && !('top_k' in c) && !('thinking_level' in c));
    t('returned object equals validAssist', JSON.stringify(out) === JSON.stringify(validAssist), JSON.stringify(out));
    t('log line has verdict + thought tokens', logs.some(([l, m]) => l === 'log' && /ADJUST/.test(m) && /คิด 321 tok/.test(m)), JSON.stringify(logs));

    console.log('\nuser prompt content (XAUUSD scalp):');
    const up = req.contents;
    t('TA block with tp2/valid_until/invalidation/playbook', ['TP2 4035.00', 'valid_until_utc): 2026-08-24T14:00:00Z', 'invalidation ของ TA: หลุด 3985', 'playbook: scalp #1'].every((s) => up.includes(s)));
    t('TA summary trimmed to 12 lines + …', up.includes('บรรทัด 12 ของสรุป') && !up.includes('บรรทัด 13 ของสรุป') && up.includes('…'));
    t('runtime block incl. daily P&L', up.includes('R:R ขั้นต่ำที่ยอมรับ: 1.5') && up.includes('P&L วันนี้: -42.50 USD'));
    t('time/session block', up.includes('## เวลา/SESSION') && up.includes('สถานะตลาด:') && up.includes('ขอบเขตถัดไป') && up.includes('Friday cutoff'));
    t('market data: xauusd_5m (24 closed) + xauusd_15m (12) + live bar', up.includes('### xauusd_5m (5m) — 24 แท่ง') && up.includes('### xauusd_15m (15m) — 12 แท่ง') && up.includes('แท่งปัจจุบัน (ยังไม่ปิด)'));
    t('bar lines use 2 decimals and the indicator set', /O \d+\.\d{2} H \d+\.\d{2} L \d+\.\d{2} C \d+\.\d{2} \| EMA20 \d+\.\d{2} EMA50 \d+\.\d{2} EMA200 \d+\.\d{2} \| RSI \d+\.\d ATR14 \d+\.\d{2} RVOL \d+\.\d{2}/.test(up));
    t('derived levels: day/prev/asian/round/swing/EMA stack', ['## ระดับที่คำนวณให้', 'วันนี้ (UTC): high', 'วันก่อน: high', 'Asian range', 'เลขกลม ($50/$100 ทุก 50.00)', 'swing high ล่าสุด', 'EMA stack'].every((s) => up.includes(s)));
    t('TA level distances in pips/ATR', /entry 4001\.50: ห่างราคาล่าสุด [+-]\d+\.\d pips \/ \d+\.\d{2} ATR/.test(up) && /SL ห่าง entry [+-]\d+\.\d pips/.test(up));
    t('companions with label + % change', up.includes('- dxy_15m: ปิด') && up.includes('DXY สวนทอง') && /1 แท่ง [+-]\d+\.\d{2}%/.test(up));
    t('news: relevant first, ★ marked', up.indexOf('★ [Investing.com]') < up.indexOf('[CNBC]'));
    t('closing instruction', up.trim().endsWith('ตามสคีมา') || up.includes('ตอบเป็น JSON ตาม schema (ราคาทศนิยม 2 ตำแหน่ง)'));
    t('xauusd_1d not printed as exec TF in scalp (only used for prev-day)', !up.includes('### xauusd_1d'));

    console.log('\nfail-safe:');
    captured = []; logs = [];
    svc = makeService('{not json');
    t('invalid JSON reply → null', (await svc.assist('scalp', TA, series, runtime, { profile: XAUUSD_PROFILE, news: [], now: new Date(NOW) })) === null);
    t('…with a warn log', logs.some(([l, m]) => l === 'warn' && /JSON/.test(m)));
    svc = makeService(JSON.stringify({ ...validAssist, verdict: 'MAYBE' }));
    t('bad verdict → null', (await svc.assist('scalp', TA, series, runtime)) === null);
    svc = makeService(JSON.stringify({ ...validAssist, size: 'double' }));
    t('bad size → null', (await svc.assist('scalp', TA, series, runtime)) === null);
    svc = makeService(JSON.stringify({ ...validAssist, sl: 'abc' }));
    t('non-numeric sl → null', (await svc.assist('scalp', TA, series, runtime)) === null);
    svc = makeService(JSON.stringify({ ...validAssist, confidence: 42 }));
    t('confidence clamped to 10', (await svc.assist('scalp', TA, series, runtime)).confidence === 10);
    svc = makeService('');
    t('empty text → null', (await svc.assist('scalp', TA, series, runtime)) === null);
    svc = makeService(JSON.stringify(validAssist));
    svc.client.models.generateContent = async () => { throw new Error('HTTP 400 boom'); };
    t('thrown error → null (no throw)', (await svc.assist('scalp', TA, series, runtime)) === null);
    logs = [];
    const noKey = new GoldGeminiService({ get: (k, d) => d });
    noKey.logger = { log() { }, warn: (m) => logs.push(m), error() { } };
    t('no GEMINI_API_KEY → null + warn', (await noKey.assist('scalp', TA, series, runtime)) === null && logs.length === 1);

    console.log('\nbackward compat (ctx omitted = XAUUSD):');
    captured = [];
    svc = makeService(JSON.stringify(validAssist));
    await svc.assist('scalp', TA, series, runtime);
    t('defaults to XAUUSD profile', captured[0].config.systemInstruction.includes('(XAUUSD)') && captured[0].contents.includes('xauusd_5m'));
    t('null series does not crash', (await makeService(JSON.stringify(validAssist)).assist('intraday', TA, null, runtime)) !== null);

    console.log('\nother profiles / modes build without throwing:');
    const s2 = new GoldGeminiService(cfgSvc);
    for (const mode of ['scalp', 'intraday', 'swing', 'position']) {
        for (const p of [XAUUSD_PROFILE, EURUSD_PROFILE, USDJPY_PROFILE]) {
            let ok = true, err = '';
            try {
                const sp = s2.buildSystemPrompt(p, mode, p.key === 'XAUUSD' ? 4000 : p.key === 'USDJPY' ? 147.25 : 1.0842);
                const upx = s2.buildUserPrompt(mode, TA, series, runtime, { profile: p, news }, new Date(NOW));
                ok = sp.includes(`${mode} #1:`) && upx.length > 500;
            } catch (e) { ok = false; err = e.message; }
            t(`${p.key}/${mode}`, ok, err);
        }
    }
    const jp = s2.buildSystemPrompt(USDJPY_PROFILE, 'scalp', 150);
    t('USDJPY pip value via usdPerUnitMovePerLot at price 150 = 6.67 USD/lot', jp.includes('ขยับ 1 pip = 6.67 USD/lot'));
    const eu = s2.buildUserPrompt('scalp', { ...TA, entry: 1.08421, sl: 1.08201, tp1: 1.08711 }, null, runtime, { profile: EURUSD_PROFILE, news: [] }, new Date(NOW));
    t('EURUSD prices printed with 5 decimals', eu.includes('entry 1.08421 | SL 1.08201 | TP1 1.08711'));

    console.log(`\n${fail === 0 ? '✅ ผ่านหมด' : '❌ พัง'} ${pass}/${pass + fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
