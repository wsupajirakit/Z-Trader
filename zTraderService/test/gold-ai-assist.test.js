const { GoldAutomateService } = require('../dist/gold/gold-automate.service');
const { XAUUSD_PROFILE } = require('../dist/gold/domain/instruments');
const svc = Object.create(GoldAutomateService.prototype);
svc.logger = { warn: () => {}, log: () => {}, error: () => {} };
// applyAssist ตอนนี้รับ p (ตราสาร) เป็น parameter ที่ 4 มี default = this.profile
// ซึ่งอ่าน this.instruments.active — ต้อง mock ให้ครบไม่งั้น default parameter จะ throw
svc.instruments = { active: XAUUSD_PROFILE, cachedSymbolId: () => 41 };
// ต้องมีราคาสด "สด" เสมอ — ตอนนี้ไม่มี tick / tick ค้าง = ปฏิเสธระดับใหม่ของ AI (ตรวจฝั่งไม่ได้)
// TA เป็น BUY_LIMIT ที่ 4000 จึงตั้งตลาดไว้เหนือ entry เพื่อให้ผ่านด่านฝั่งออเดอร์
svc.ticks = new Map([[XAUUSD_PROFILE.key, { bid: 4009, ask: 4010, at: Date.now() }]]);
const apply = (ta, ai, rr) => GoldAutomateService.prototype['applyAssist'].call(svc, ta, ai, rr);

const TA = { order_type:'BUY_LIMIT', entry:4000, sl:3980, tp1:4040, tp2:4060, rr_tp1:2,
             confidence:7, size:'full', reason:'TA setup', playbook_ref:'swing #1',
             invalidation:'', valid_until_utc:null, analysis_summary:'' };
const A = (o) => ({ verdict:'ADJUST', entry:null, sl:null, tp1:null, tp2:null,
                    size:'full', confidence:8, key_levels:'', risk_note:'', reason:'', ...o });
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name)); };

console.log('AI ปิด/ล่ม:');
t('ไม่มี assist = ใช้ TA เดิมทุกค่า', JSON.stringify(apply(TA, null, 1.5)) === JSON.stringify(TA));

console.log('AI ขัดในกรอบ:');
const ok = apply(TA, A({ entry:4005, sl:3985, tp1:4045 }), 1.5);
t('รับระดับใหม่', ok.entry === 4005 && ok.sl === 3985);
t('คำนวณ R:R ใหม่ให้', ok.rr_tp1 === 2);

console.log('ด่านกันเพี้ยน:');
const far = apply(TA, A({ entry:4400 }), 1.5);
t('ขยับ entry 10% = ปฏิเสธ ใช้ของ TA', far.entry === 4000);
const bad = apply(TA, A({ entry:4000, sl:4050 }), 1.5);
t('SL ผิดฝั่ง = ใช้ของ TA', bad.sl === 3980);
const thin = apply(TA, A({ entry:4000, sl:3980, tp1:4005 }), 1.5);
t('R:R ต่ำกว่าขั้นต่ำ = ไม่เข้า', thin.order_type === 'NO_TRADE');
const veto = apply(TA, A({ verdict:'VETO', reason:'ใกล้ข่าว' }), 1.5);
t('VETO = ไม่เข้า', veto.order_type === 'NO_TRADE' && veto.entry === null);

console.log('ราคาสดใช้ไม่ได้ = ไม่รับระดับใหม่:');
{
    const saved = svc.ticks;
    svc.ticks = new Map();                      // ไม่มี tick เลย
    const r1 = apply(TA, A({ entry: 4005, sl: 3985, tp1: 4045 }), 1.5);
    t('ไม่มีราคาสด = ใช้ระดับของ TA', r1.entry === 4000 && r1.sl === 3980);
    // tick ค้างเกิน STALE_TICK_MS (90 วิ) = เชื่อไม่ได้เท่ากับไม่มี
    svc.ticks = new Map([[XAUUSD_PROFILE.key, { bid: 4009, ask: 4010, at: Date.now() - 5 * 60_000 }]]);
    const r2 = apply(TA, A({ entry: 4005, sl: 3985, tp1: 4045 }), 1.5);
    t('ราคาสดค้าง = ใช้ระดับของ TA', r2.entry === 4000 && r2.sl === 3980);
    svc.ticks = saved;
}

console.log('ขนาดไม้:');
t('AI เพิ่มไม้ไม่ได้', apply({...TA,size:'quarter'}, A({size:'full'}), 1.5).size === 'quarter');
t('AI ลดไม้ได้', apply(TA, A({size:'half'}), 1.5).size === 'half');

console.log(`\n${fail === 0 ? '✅ ผ่านหมด' : '❌ พัง'} ${pass}/${pass+fail}`);
process.exit(fail ? 1 : 0);
