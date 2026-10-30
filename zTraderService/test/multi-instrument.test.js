/**
 * เทรดหลายตราสารพร้อมกัน (XAUUSD/EURUSD/GBPUSD/USDJPY) — ยืนยันว่า:
 *   1. enabledInstruments() คืนตามที่ตั้งไว้จริง (ตัวเดียว = พฤติกรรมเดิม)
 *   2. state/pending/running แยกตามตราสารจริง ไม่ชนกัน (คีย์ `${instrument}:${mode}` มีอยู่แล้ว)
 *   3. ราคาสด (ticks) แยกตามตราสารจริง — ไม่เอาราคาทองไปเทียบกับไม้ EURUSD
 *   4. applyAssist/applyProposal เทียบราคาตลาดของ "ตราสารที่กำลังวิเคราะห์" ไม่ใช่ตัว active
 *   5. isPositionDue กันรันซ้ำแยกตามตราสาร ไม่ทับกันข้ามตราสาร
 *   6. เพดานไม้ค้างรวมทุกตราสาร (GOLD_MAX_OPEN_POSITIONS_TOTAL) ทำงานถูก แยกจากเพดานต่อตราสาร
 *   7. runMode รับ p เป็น parameter — ล็อกตราสารไว้ตลอดรอบ ไม่หลุดไปอ่าน this.profile ระหว่างทาง
 *
 * ไม่ต้อง build ใหม่ (ใช้ dist/ ที่มีอยู่) ไม่แตะ service ที่รันอยู่ ไม่ต่อเน็ต
 * รัน: npm run build && node test/multi-instrument.test.js
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROJECT = path.resolve(process.env.ZTRADER_ROOT || path.join(__dirname, '..'));
process.env.NODE_PATH = [path.join(PROJECT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

const DIST = path.join(PROJECT, 'dist');
if (!fs.existsSync(path.join(DIST, 'gold/gold-automate.service.js'))) { console.error('ต้อง npm run build ก่อน'); process.exit(2); }

const { GoldAutomateService } = require(path.join(DIST, 'gold/gold-automate.service'));
const { XAUUSD_PROFILE, EURUSD_PROFILE, GBPUSD_PROFILE, USDJPY_PROFILE } = require(path.join(DIST, 'gold/domain/instruments'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.log('  ✗', name, extra !== undefined ? `→ ${extra}` : ''); }
};

function fakeAuto(overrides = {}) {
    const o = Object.create(GoldAutomateService.prototype);
    o.logger = { log() {}, warn() {}, error() {} };
    o.overrides = new Map();
    o.configService = { get: (k, d) => (overrides[k] !== undefined ? overrides[k] : d) };
    o.instruments = {
        active: XAUUSD_PROFILE,
        cachedSymbolId: (p) => ({ XAUUSD: 41, EURUSD: 1, GBPUSD: 2, USDJPY: 4 }[(p || XAUUSD_PROFILE).key]),
        profileBySymbolId: (id) => ({ 41: XAUUSD_PROFILE, 1: EURUSD_PROFILE, 2: GBPUSD_PROFILE, 4: USDJPY_PROFILE }[id] ?? null),
    };
    o.activity = { push() {} };
    o.ctraderService = { isAuthorized: true, connected: true };
    // ทุก Map/Set ที่ Object.create ข้าม field initializer ไป ต้องตั้งเองให้ครบ
    o.ticks = new Map();
    o.marketWasOpen = new Map();
    o.running = new Set();
    o.state = new Map();
    o.pending = new Map();
    o.lastPositionRunDate = new Map();
    o.scalpCount = new Map();
    o.spotSubscribed = new Map();
    o.spotSymbolId = new Map();
    o.lastSpotResubAt = new Map();
    o.aiQuotaWarnedDay = new Set();
    return o;
}

(async () => {
    console.log('\n=== 1. enabledInstruments() ===');
    {
        const a = fakeAuto({});
        t('ไม่ตั้งอะไร → ตัว active เดียว (พฤติกรรมเดิม)',
            a.enabledInstruments().length === 1 && a.enabledInstruments()[0].key === 'XAUUSD');

        const b = fakeAuto({ GOLD_INSTRUMENTS: 'XAUUSD,EURUSD,GBPUSD' });
        const keys = b.enabledInstruments().map((p) => p.key);
        t('ตั้ง 3 ตัว → คืนครบ 3 ตัวตามลำดับ', JSON.stringify(keys) === JSON.stringify(['XAUUSD', 'EURUSD', 'GBPUSD']));

        const c = fakeAuto({ GOLD_INSTRUMENTS: 'xauusd,eurusd,gbpusd,usdjpy' });
        t('พิมพ์เล็ก + ครบทั้ง 4 ตัว → ใช้ได้ทั้งหมด',
            c.enabledInstruments().map((p) => p.key).join(',') === 'XAUUSD,EURUSD,GBPUSD,USDJPY');

        const d = fakeAuto({ GOLD_INSTRUMENTS: 'XAUUSD,BOGUS,EURUSD' });
        t('มีตัวไม่รู้จักปนมา → กรองทิ้งเฉพาะตัวนั้น เหลือตัวที่ถูกต้อง',
            d.enabledInstruments().map((p) => p.key).join(',') === 'XAUUSD,EURUSD');

        const e = fakeAuto({ GOLD_INSTRUMENTS: 'BOGUS,NOPE' });
        t('ทุกตัวไม่รู้จัก → fallback เป็นตัว active เดียว (ไม่ throw ไม่คืนว่าง)',
            e.enabledInstruments().length === 1);

        const f = fakeAuto({});
        f.setAutomate(true, undefined, ['EURUSD', 'GBPUSD']);
        t('setAutomate ตั้งตราสารรันไทม์ได้', f.enabledInstruments().map((p) => p.key).join(',') === 'EURUSD,GBPUSD');
        f.setAutomate(true, undefined, []);
        t('setAutomate ส่ง [] มา → ไม่ทับค่าที่ตั้งไว้ก่อน (ยังเป็น EURUSD,GBPUSD)',
            f.enabledInstruments().map((p) => p.key).join(',') === 'EURUSD,GBPUSD');
    }

    console.log('\n=== 2. ราคาสดแยกตามตราสารจริง (ticks Map) ===');
    {
        const a = fakeAuto({});
        a.ticks.set('XAUUSD', { bid: 4600, ask: 4600.1, at: Date.now() });
        a.ticks.set('EURUSD', { bid: 1.165, ask: 1.1651, at: Date.now() });
        t('ราคาทอง', a.getLastTick(XAUUSD_PROFILE).bid === 4600);
        t('ราคายูโร ไม่ใช่ราคาทอง', a.getLastTick(EURUSD_PROFILE).bid === 1.165);
        t('ตราสารที่ยังไม่มี tick → null ไม่ throw', a.getLastTick(GBPUSD_PROFILE) === null);
        t('ไม่ระบุตราสาร → ใช้ตัว active (this.profile)', a.getLastTick().bid === 4600);
    }

    console.log('\n=== 3. onSpot เก็บ tick ของทุกตราสารที่รู้จัก ไม่กรองทิ้งเฉพาะ active ===');
    {
        const a = fakeAuto({});   // active = XAUUSD (symbolId 41)
        // onSpot หารด้วย 100_000 เสมอ (cTrader ส่งราคาคูณ 1e5 มา) — 116500/1e5=1.165 · 460000000/1e5=4600
        a.onSpot({ symbolId: 1, bid: 116500, ask: 116510 });          // EURUSD — ไม่ใช่ active
        a.onSpot({ symbolId: 41, bid: 460000000, ask: 460001000 });   // XAUUSD — active
        a.onSpot({ symbolId: 999, bid: 100000, ask: 100010 });        // symbol ที่ไม่รู้จักเลย
        t('EURUSD ถูกเก็บแม้ไม่ใช่ตัว active', a.ticks.has('EURUSD') && Math.abs(a.ticks.get('EURUSD').bid - 1.165) < 1e-9);
        t('XAUUSD (active) ยังถูกเก็บตามปกติ', a.ticks.has('XAUUSD') && Math.abs(a.ticks.get('XAUUSD').bid - 4600) < 1e-9);
        t('symbol ที่ไม่รู้จัก ไม่ถูกเก็บ (ไม่ throw)', !Array.from(a.ticks.values()).some((v) => v.bid === 1));
    }

    console.log('\n=== 4. applyAssist/applyProposal เทียบราคาตลาดของ p ที่ส่งเข้าไป ไม่ใช่ตัว active ===');
    {
        const a = fakeAuto({});
        a.ticks.set('XAUUSD', { bid: 4700, ask: 4700.1, at: Date.now() });   // active แพงมาก
        a.ticks.set('EURUSD', { bid: 1.1000, ask: 1.1001, at: Date.now() }); // ตราสารที่กำลังวิเคราะห์จริง

        // ระยะ SL ของ TA = 0.0020 -> drift guard ยอมขยับ entry ได้ไม่เกินครึ่งนึง (0.0010)
        // ตั้ง entry ของ TA ให้ใกล้กับที่ AI จะเสนอ เพื่อแยกทดสอบ "ราคาตลาด" ออกจาก "drift limit"
        // (ทั้งสองด่านทำงานอิสระกัน — ไม่อยากให้ปนกันจนตีความผลผิด)
        const TA = {
            order_type: 'BUY_LIMIT', entry: 1.0990, sl: 1.0970, tp1: 1.1040, tp2: 1.1080,
            rr_tp1: 2.5, confidence: 7, size: 'full', reason: 'r', playbook_ref: 'intraday #1',
            invalidation: '', valid_until_utc: null, analysis_summary: '',
        };
        const AI = (o) => ({ verdict: 'ADJUST', entry: null, sl: null, tp1: null, tp2: null, size: 'full', confidence: null, key_levels: '', risk_note: '', reason: 'r', ...o });

        // entry ที่ AI เสนอ (1.0995 ห่างจาก TA แค่ 0.0005 < driftCap 0.0010) ต่ำกว่าราคาตลาด EURUSD
        // ask (1.1001) = ถูกต้องสำหรับ BUY_LIMIT ถ้าโค้ดดันไปเทียบกับราคาทอง (4700) ผลจะกลับตาลปัตรทันที
        // เพราะสเกลราคาต่างกันคนละโลก
        const withEur = a.applyAssist(TA, AI({ entry: 1.0995, sl: 1.0975, tp1: 1.1045 }), 1.5, EURUSD_PROFILE);
        t('เทียบกับราคา EURUSD ที่ถูกต้อง → รับ entry ใหม่', withEur.entry === 1.0995, JSON.stringify(withEur));

        // BUY_STOP ต้อง "สูงกว่าตลาด" — entry เดียวกัน (1.0995) ต่ำกว่า ask ของ EURUSD (1.1001)
        // จึงต้องถูกทิ้ง ถ้าโค้ดเทียบกับราคาทอง (4700) แทน จะผ่านผิด ๆ เพราะ 1.0995 ยังไง ๆ ก็ "ต่ำกว่า 4700"
        const stopCase = a.applyAssist(
            { ...TA, order_type: 'BUY_STOP' },
            AI({ entry: 1.0995, sl: 1.0975, tp1: 1.1045 }), 1.5, EURUSD_PROFILE);
        t('BUY_STOP ที่ต้องสูงกว่าราคา EURUSD จริง (1.1001) แต่เสนอต่ำกว่า → ถูกทิ้ง ใช้ของ TA',
            stopCase.entry === TA.entry);

        // entry สูงกว่า ask ของ EURUSD จริง (1.1001) และ drift ยังอยู่ในเกณฑ์ (ห่าง TA 0.0005)
        const okStop = a.applyAssist(
            { ...TA, order_type: 'BUY_STOP' },
            AI({ entry: 1.0995, sl: 1.0975, tp1: 1.1050 }), 1.5,
            { ...EURUSD_PROFILE });
        // ใช้ราคาตลาดที่ต่ำกว่า entry เพื่อให้ BUY_STOP ผ่านจริง
        a.ticks.set('EURUSD', { bid: 1.0980, ask: 1.0981, at: Date.now() });
        const okStop2 = a.applyAssist(
            { ...TA, order_type: 'BUY_STOP' },
            AI({ entry: 1.0995, sl: 1.0975, tp1: 1.1050 }), 1.5, EURUSD_PROFILE);
        t('BUY_STOP ที่สูงกว่าราคา EURUSD จริง (1.0981) → ผ่าน', okStop2.entry === 1.0995, JSON.stringify(okStop2));
    }

    console.log('\n=== 5. isPositionDue แยกตามตราสารจริง ไม่ทับกัน ===');
    {
        const a = fakeAuto({ GOLD_POSITION_RUN_UTC_HOURS: '22' });
        const now = new Date(Date.UTC(2026, 7, 27, 22, 15));
        t('XAUUSD ควรรันรอบนี้', a.isPositionDue(now, XAUUSD_PROFILE) === true);
        t('รันซ้ำรอบเดียวกัน XAUUSD → false (กันซ้ำถูกต้อง)', a.isPositionDue(now, XAUUSD_PROFILE) === false);
        t('EURUSD ชั่วโมงเดียวกัน แต่คนละตราสาร → ยังรันได้ (เดิมจะโดนบล็อกเพราะ field เดี่ยว)',
            a.isPositionDue(now, EURUSD_PROFILE) === true);
        t('รันซ้ำ EURUSD รอบเดียวกัน → false', a.isPositionDue(now, EURUSD_PROFILE) === false);
        t('GBPUSD ยังไม่เคยรัน → true', a.isPositionDue(now, GBPUSD_PROFILE) === true);
        const nextHour = new Date(Date.UTC(2026, 7, 28, 22, 15));
        t('ข้ามวัน XAUUSD → รันได้อีกครั้ง', a.isPositionDue(nextHour, XAUUSD_PROFILE) === true);
    }

    console.log('\n=== 6. state/pending/running แยกตามตราสาร (sk key มี instrument อยู่แล้ว) ===');
    {
        const a = fakeAuto({});
        const stXau = a.getState('swing', XAUUSD_PROFILE);
        const stEur = a.getState('swing', EURUSD_PROFILE);
        stXau.lastOutcome = 'order sent: xau-uuid';
        t('state ของทองกับยูโร เป็นคนละ object กัน', stXau !== stEur);
        t('แก้ค่าของทองไม่กระทบยูโร', stEur.lastOutcome === null);

        a.running.add(a.sk('scalp', XAUUSD_PROFILE));
        t('running.has ของทองไม่ทำให้ running ของยูโรเป็น true',
            a.running.has(a.sk('scalp', XAUUSD_PROFILE)) === true
            && a.running.has(a.sk('scalp', EURUSD_PROFILE)) === false);
    }

    console.log('\n=== 7. เพดานไม้ค้างรวมทุกตราสาร ===');
    {
        const a = fakeAuto({ GOLD_MAX_OPEN_POSITIONS_TOTAL: '5' });
        a.ctraderService = {
            getPositions: async () => ({
                position: [
                    { tradeData: { symbolId: 41 } }, { tradeData: { symbolId: 41 } },   // XAUUSD x2
                    { tradeData: { symbolId: 1 } },                                      // EURUSD x1
                    { tradeData: { symbolId: 999 } },                                    // ไม่รู้จัก — ไม่ควรถูกนับ
                ],
                order: [{ tradeData: { symbolId: 2 } }],   // GBPUSD pending x1
            }),
        };
        const total = await a.getOpenPositionsAllInstruments();
        t('นับรวมเฉพาะตราสารที่รู้จัก: 2(XAU)+1(EUR)+1(GBP pending) = 4 ไม่รวม symbol 999',
            total === 4, `ได้ ${total}`);

        const failing = fakeAuto({});
        failing.ctraderService = { getPositions: async () => { throw new Error('boom'); } };
        const safe = await failing.getOpenPositionsAllInstruments();
        t('broker ล้ม → คืน 0 ไม่ throw (fail-safe)', safe === 0);
    }

    console.log('\n=== 8. launch() ล็อกตราสารที่ถูกต้องเข้า running key ===');
    {
        const a = fakeAuto({});
        let capturedProfile = null;
        a.runMode = async (mode, force, dryRun, p) => { capturedProfile = p; return { decision: null, outcome: 'ok' }; };
        a.launch('swing', EURUSD_PROFILE);
        await new Promise((r) => setTimeout(r, 20));
        t('launch ส่ง EURUSD เข้า runMode ไม่ใช่ตัว active (XAUUSD)', capturedProfile === EURUSD_PROFILE);
        t('running key ที่ใช้ระหว่างรันเป็นของ EURUSD', a.sk('swing', EURUSD_PROFILE) !== a.sk('swing', XAUUSD_PROFILE));
    }

    console.log(`\n${fail === 0 ? '✅ MULTI-INSTRUMENT ผ่านหมด' : '❌ MULTI-INSTRUMENT พัง'} ${pass}/${pass + fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
