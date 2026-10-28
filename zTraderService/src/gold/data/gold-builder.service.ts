import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import YahooFinance from 'yahoo-finance2';
import Parser from 'rss-parser';
import { CtraderService } from '../../ctrader/ctrader.service';
import { GoldExport, GoldMode } from './gold-data.service';
import { Bar, EnrichedBar, enrich } from '../domain/indicators';
import {
    ANALYSIS_REQUEST,
    CTRADER_PERIOD,
    GoldModeSpec,
    INTERVAL_MS,
    NEWS_FEEDS,
    YAHOO_INTERVAL,
    YAHOO_SYMBOL,
} from '../domain/gold-modes';
import { FX_NEWS_FEEDS } from '../domain/fx-modes';
import { InstrumentProfile, XAUUSD_PROFILE } from '../domain/instruments';
import { GoldInstrumentService } from '../gold-instrument.service';
import { errorMessage } from '../../common/utils/errors';

const PRICE_DIVISOR = 100_000; // cTrader Open API prices are ints × 1e5

/** ข่าวหนึ่งชิ้นที่ส่งให้ Claude/dashboard — relevant = หัวข้อมี keyword ของตราสารที่ขอ */
export interface NewsItem {
    source: string;
    title: string;
    pubDate: string;
    link: string;
    relevant: boolean;
}
/** รายการดิบในแคช (รวมทุก feed ใช้ร่วมกันทุกตราสาร) — ts ใช้เรียงเท่านั้น ไม่ส่งออก */
interface RawNewsItem {
    source: string;
    title: string;
    pubDate: string;
    link: string;
    ts: number;
}

/** feed ทั้งหมดที่ดึง (ทอง + forex) — dedupe ตาม url; จัดอันดับตามโปรไฟล์ทีหลัง */
const ALL_NEWS_FEEDS: Array<{ name: string; url: string }> = (() => {
    const seen = new Set<string>();
    return [...NEWS_FEEDS, ...FX_NEWS_FEEDS].filter((f) => (seen.has(f.url) ? false : (seen.add(f.url), true)));
})();

/**
 * Builds the same gold_<mode> data set as z-service backend/gold.py, but
 * natively inside this service — no HTTP pull needed:
 *   - main symbol bars: cTrader Open API trendbars (exact feed of the trading account)
 *   - companions:       Yahoo Finance (4h resampled from 60m)
 *   - indicators/formula/news: 1:1 port of gold.py
 * Output shape (GoldExport) is identical to the ZIP pull, so the AI prompt
 * and the automate flow are unchanged.
 *
 * รองรับหลายตราสารผ่าน InstrumentProfile (ค่าเริ่มต้น XAUUSD_PROFILE = พฤติกรรมเดิมเป๊ะ):
 * โหมด/ชุด symbol/ทศนิยม/ข้อความ prompt/การจัดอันดับข่าว ล้วนอ่านจากโปรไฟล์
 */
@Injectable()
export class GoldBuilderService {
    private readonly logger = new Logger(GoldBuilderService.name);
    private readonly rss = new Parser({ timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    private readonly yahoo = new (YahooFinance as any)({ suppressNotices: ['yahooSurvey'] });
    /** key = `${profile.key}:${mode}` */
    private cache = new Map<string, { expires: number; data: GoldExport; withNews: boolean }>();

    /**
     * แปลง error เป็นข้อความที่อ่านออก — cTrader ตอบกลับเป็น "payload object"
     * (เช่น { errorCode, description }) ไม่ใช่ Error จึงไม่มี .message
     * โค้ดเดิมใช้ `e?.message ?? e` แล้วเอาไปต่อใน template = ได้ "[object Object]"
     * ซึ่งกลืนสาเหตุจริงทิ้งทั้งหมด ทำให้ไล่ปัญหาจาก log ไม่ได้เลย
     */
    /**
     * คิวจำกัดอัตราการขอแท่งเทียนจาก cTrader — ต้องมี ห้ามยิงพร้อมกัน
     *
     * ตอนรองรับตราสารเดียวมีอย่างมาก 4 โหมด · พอเปิดพร้อมกัน 4 ตราสารกลายเป็น 16 รอบ
     * ที่ตื่นพร้อมกันตอนแท่งปิด แต่ละรอบยิงขอหลาย TF ผ่าน Promise.all อีกชั้น
     * -> cTrader ตอบ "BLOCKED_PAYLOAD_TYPE: You are being rate limited" แล้ว build ล้มทั้งตราสาร
     *    ขึ้น "unavailable on all TFs — DO NOT TRADE this round" (เจอจริง 27 ส.ค.)
     * เว้นระยะ ~250ms ต่อคำขอ = ~4 ครั้ง/วินาที อยู่ใต้เพดานของ broker
     */
    private ctraderGate: Promise<void> = Promise.resolve();
    private static readonly CTRADER_MIN_GAP_MS = 250;

    /** ต่อคิวคำขอ cTrader ให้ห่างกันอย่างน้อย CTRADER_MIN_GAP_MS */
    private throttleCtrader<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.ctraderGate.then(fn);
        // ตัวคิวถัดไปรอ "คำขอนี้จบ + เว้นช่วง" · .catch กันคิวพังทั้งสายเมื่อคำขอหนึ่งล้ม
        this.ctraderGate = run.then(
            () => new Promise((r) => setTimeout(r, GoldBuilderService.CTRADER_MIN_GAP_MS)),
            () => new Promise((r) => setTimeout(r, GoldBuilderService.CTRADER_MIN_GAP_MS)),
        );
        return run;
    }

    private errText(e: any): string {
        if (e == null) return 'ไม่ทราบสาเหตุ';
        if (typeof e === 'string') return e;
        if (errorMessage(e)) return String(errorMessage(e));
        if (e.errorCode || e.description) {
            return [e.errorCode, e.description].filter(Boolean).join(': ');
        }
        try {
            return JSON.stringify(e);
        } catch {
            return String(e);
        }
    }
    private newsCache: { expires: number; items: RawNewsItem[] } | null = null;
    private newsInflight: Promise<RawNewsItem[]> | null = null;

    constructor(
        private configService: ConfigService,
        private ctraderService: CtraderService,
        private instrumentService: GoldInstrumentService,
    ) {}

    getModesInfo(profile: InstrumentProfile = XAUUSD_PROFILE) {
        return {
            source: `local (${profile.key}: cTrader, companions: Yahoo Finance)`,
            instrument: profile.key,
            name_th: profile.name_th,
            emoji: profile.emoji,
            modes: Object.entries(profile.modes).map(([mode, s]) => ({
                mode,
                horizon: s.horizon,
                tf_roles: s.tfRoles,
                ttl: s.ttl,
                rr_min: s.rrMin,
                files: s.sets.map((x) => `${x.symbol.toLowerCase()}_${x.tf}.csv`),
            })),
        };
    }

    /**
     * @param withNews embed LATEST_FINANCIAL_NEWS into gold_formula.csv —
     * only the AI engine reads the formula, so the TA path skips the RSS
     * round-trip entirely (ข่าวสำหรับคน/Claude อ่าน ไม่ใช่สูตรตัวเลข)
     * @param profile ตราสารหลัก (default XAUUSD) — symbol หลักดึงจาก cTrader ที่เหลือจาก Yahoo
     */
    async build(mode: GoldMode, withNews = false, profile: InstrumentProfile = XAUUSD_PROFILE): Promise<GoldExport> {
        const spec = profile.modes[mode];
        if (!spec) throw new Error(`unknown gold mode "${mode}"`);

        const cacheKey = `${profile.key}:${mode}`;
        const hit = this.cache.get(cacheKey);
        if (hit && hit.expires > Date.now() && (!withNews || hit.withNews)) {
            return { ...hit.data, cacheHit: true };
        }

        const files = new Map<string, string>();
        const series: Record<string, EnrichedBar[]> = {};
        const errors: string[] = [];
        let mainOk = 0;

        await Promise.all(
            spec.sets.map(async ({ symbol, tf, nBars }) => {
                try {
                    const isMain = symbol === profile.key;
                    const bars = isMain
                        ? await this.fetchCtraderBars(await this.instrumentService.resolveSymbolId(profile), tf, nBars)
                        : await this.fetchYahooBars(symbol, tf, nBars);
                    if (bars.length < Math.min(60, nBars)) {
                        throw new Error(`only ${bars.length} bars`);
                    }
                    const key = `${symbol.toLowerCase()}_${tf}`;
                    const rows = enrich(bars);
                    series[key] = rows;
                    const source = isMain ? 'ICMARKETS(cTrader)' : 'YAHOO';
                    files.set(`${key}.csv`, this.symbolCsv(mode, source, symbol, tf, rows, profile));
                    if (isMain) mainOk++;
                } catch (e) {
                    errors.push(`${symbol} ${tf} -> ${errorMessage(e)}`);
                }
            }),
        );

        if (mainOk === 0) {
            throw new Error(
                `build: ${profile.key} unavailable on all TFs — DO NOT TRADE this round (${errors.join(' | ')})`,
            );
        }

        const formula = await this.formulaCsv(mode, spec, withNews, profile);
        const data: GoldExport = {
            mode,
            files,
            formula,
            series,
            errors: errors.length ? errors.join('\n') : null,
            cacheHit: false,
            instrument: profile.key,
        };
        this.cache.set(cacheKey, { expires: Date.now() + spec.ttl * 1000, data, withNews });
        return data;
    }

    // ---------------- main symbol from cTrader ----------------

    private async fetchCtraderBars(symbolId: number, tf: string, nBars: number): Promise<Bar[]> {
        if (!this.ctraderService.isAuthorized) throw new Error('cTrader not authorized');
        const periodMs = INTERVAL_MS[tf];
        const now = Date.now();

        // cTrader hiccups on single requests (เจอจริง: timeout พร้อมกัน 3 TF) —
        // retry หนึ่งรอบเหมือน gold.py ก่อนยอมแพ้
        let res: any = null;
        let lastErr: any = null;
        for (const attempt of [1, 2]) {
            try {
                res = await this.throttleCtrader(() =>
                    this.ctraderService.request<any>(
                        'ProtoOAGetTrendbarsReq',
                        {
                            ctidTraderAccountId: this.ctraderService.activeAccountId,
                            // ×3 buffer covers weekends/holidays so `count` bars actually exist in range
                            fromTimestamp: now - nBars * periodMs * 3,
                            toTimestamp: now,
                            period: CTRADER_PERIOD[tf],
                            symbolId,
                            count: nBars,
                        },
                        45_000,
                    ),
                );
                if ((res?.trendbar ?? []).length) break;
                lastErr = new Error('cTrader returned 0 trendbars');
            } catch (e) {
                lastErr = e;
            }
            if (attempt === 1) {
                this.logger.warn(`trendbar ${tf} attempt 1 failed (${this.errText(lastErr)}) — retrying`);
                await new Promise((r) => setTimeout(r, 1500));
            }
        }

        const raw = (res?.trendbar ?? []) as any[];
        if (!raw.length) throw new Error(`cTrader trendbars ${tf} ไม่สำเร็จหลัง retry: ${this.errText(lastErr)}`);

        const num = (v: any) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));
        const bars: Bar[] = raw
            .map((b) => {
                const low = num(b.low) / PRICE_DIVISOR;
                return {
                    ts: num(b.utcTimestampInMinutes) * 60_000,
                    open: low + num(b.deltaOpen) / PRICE_DIVISOR,
                    high: low + num(b.deltaHigh) / PRICE_DIVISOR,
                    low,
                    close: low + num(b.deltaClose) / PRICE_DIVISOR,
                    volume: num(b.volume),
                };
            })
            .sort((a, b) => a.ts - b.ts);
        return bars.slice(-nBars);
    }

    // ---------------- companions from Yahoo ----------------

    private async fetchYahooBars(symbol: string, tf: string, nBars: number): Promise<Bar[]> {
        const ySymbol = YAHOO_SYMBOL[symbol];
        if (!ySymbol) throw new Error(`no Yahoo mapping for ${symbol}`);
        const yInterval = YAHOO_INTERVAL[tf];
        if (!yInterval) throw new Error(`unsupported companion tf ${tf}`);

        const fetchN = tf === '4h' ? nBars * 4 : nBars;
        const periodMs = tf === '4h' ? INTERVAL_MS['1h'] : INTERVAL_MS[tf];
        // ×3 buffer for weekends/market hours; Yahoo caps 15m/30m history at 60 days
        let lookbackMs = fetchN * periodMs * 3;
        if ((yInterval === '15m' || yInterval === '30m') && lookbackMs > 55 * 86_400_000) {
            lookbackMs = 55 * 86_400_000;
        }

        const result: any = await this.yahoo.chart(ySymbol, {
            period1: new Date(Date.now() - lookbackMs),
            period2: new Date(),
            interval: yInterval as any,
        });

        let bars: Bar[] = (result?.quotes ?? [])
            .filter((q: any) => q.close != null && q.open != null && q.high != null && q.low != null)
            .map((q: any) => ({
                ts: new Date(q.date).getTime(),
                open: q.open,
                high: q.high,
                low: q.low,
                close: q.close,
                volume: q.volume ?? 0,
            }));
        if (!bars.length) throw new Error(`Yahoo returned 0 bars for ${ySymbol} ${yInterval}`);

        if (tf === '4h') bars = this.resample(bars, INTERVAL_MS['4h']);
        return bars.slice(-nBars);
    }

    private resample(bars: Bar[], bucketMs: number): Bar[] {
        const out: Bar[] = [];
        let cur: Bar | null = null;
        let curBucket = -1;
        for (const b of bars) {
            const bucket = Math.floor(b.ts / bucketMs);
            if (bucket !== curBucket) {
                if (cur) out.push(cur);
                curBucket = bucket;
                cur = {
                    ts: bucket * bucketMs,
                    open: b.open,
                    high: b.high,
                    low: b.low,
                    close: b.close,
                    volume: b.volume,
                };
            } else if (cur) {
                cur.high = Math.max(cur.high, b.high);
                cur.low = Math.min(cur.low, b.low);
                cur.close = b.close;
                cur.volume += b.volume;
            }
        }
        if (cur) out.push(cur);
        return out;
    }

    // ---------------- CSV rendering (same layout as gold.py) ----------------

    private fmtDt(ts: number): string {
        return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
    }

    private metaLines(
        mode: string,
        source: string,
        symbol: string,
        tf: string,
        lastTs: number,
        profile: InstrumentProfile,
    ): string[] {
        const now = new Date();
        const fmtTz = (tz: string) => now.toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16);
        // session_note ตามชนิดตราสาร — ข้อความโลหะต้องเหมือนเดิมทุกตัวอักษร (regression ทอง)
        const sessionNote =
            profile.kind === 'fx'
                ? '# session_note: forex 24h/5 วัน (อาทิตย์ 17:05 ET → ศุกร์ 16:55 ET · ไม่มีพักรายวัน แต่ spread ถ่างช่วง rollover 17:00 ET) — แท่งสุดท้ายอาจยังไม่ปิด (ดูคอลัมน์ Is_Closed_Bar)'
                : '# session_note: metals ~23h/day (ปิด 17:00-18:00 ET + สุดสัปดาห์) — แท่งสุดท้ายอาจยังไม่ปิด (ดูคอลัมน์ Is_Closed_Bar)';
        return [
            `# gold_mode: ${mode} | symbol: ${symbol} | tf: ${tf} | exchange: ${source}`,
            `# generated_utc: ${now.toISOString().slice(0, 19)}Z | et: ${fmtTz('America/New_York')} | bangkok: ${fmtTz('Asia/Bangkok')}`,
            `# last_bar_start: ${this.fmtDt(lastTs)} (UTC)`,
            '# volume_note: CFD/FX volume = TICK VOLUME (proxy) — CMF/OBV/RVOL อ่านเชิงเปรียบเทียบ ไม่ใช่เงินสถาบันแบบหุ้น',
            sessionNote,
        ];
    }

    private csvCell(v: string | number | boolean): string {
        const s = String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    private csvRow(cells: Array<string | number | boolean>): string {
        return cells.map((c) => this.csvCell(c)).join(',');
    }

    private symbolCsv(
        mode: string,
        source: string,
        symbol: string,
        tf: string,
        rows: EnrichedBar[],
        profile: InstrumentProfile = XAUUSD_PROFILE,
    ): string {
        const dur = INTERVAL_MS[tf];
        const now = Date.now();
        const lines: string[] = this.metaLines(mode, source, symbol, tf, rows[rows.length - 1].ts, profile);
        lines.push(
            this.csvRow([
                'Symbol',
                'Datetime',
                'Open',
                'High',
                'Low',
                'Close',
                'Volume',
                'EMA_20',
                'EMA_50',
                'EMA_100',
                'EMA_200',
                'RSI',
                'OBV',
                'CMF_50',
                'CMF_20',
                'VWAP_20',
                'ATR_14',
                'RVOL_20',
                'Is_Closed_Bar',
            ]),
        );
        // ทศนิยมราคา = digits ของตราสาร + 1 (ทอง 2 → 3 ตำแหน่ง = ค่าเดิม · EURUSD 5 → 6) — indicator อื่นปัดเท่าเดิม
        const pm = Math.pow(10, profile.digits + 1);
        const r3 = (v: number) => Math.round(v * pm) / pm;
        const last = rows.length - 1;
        // ตัวประกอบจาก Yahoo คืน volume = 0 (^TNX ^VIX DX-Y.NYB ฯลฯ) — enrich() จึงผลิต
        // OBV=0 · CMF=0 (อ่านว่า "กระแสเงินกลาง") · VWAP=close (อ่านว่า "ราคาอยู่ที่ VWAP พอดี")
        // · RVOL=1.00 (อ่านว่า "วอลุ่มปกติ") ทั้งที่ไม่มีวอลุ่มให้คำนวณเลย
        // ตัวเลขพวกนี้ดูสมเหตุสมผลจนแยกไม่ออกว่าปลอม แล้วถูกส่งให้ AI อ่านตรง ๆ
        // -> ไม่มีวอลุ่มจริง = เว้นว่างไปเลย ให้เห็นชัดว่า "ไม่มีข้อมูล" ไม่ใช่ "เป็นกลาง"
        const hasVolume = rows.some((r) => r.volume > 0);
        const nv = (v: number | string) => (hasVolume ? v : '');
        rows.forEach((r, i) => {
            const isClosed = !(i === last && now - r.ts < dur);
            lines.push(
                this.csvRow([
                    symbol,
                    this.fmtDt(r.ts),
                    r3(r.open),
                    r3(r.high),
                    r3(r.low),
                    r3(r.close),
                    Math.round(r.volume),
                    r3(r.ema20),
                    r3(r.ema50),
                    r3(r.ema100),
                    r3(r.ema200),
                    Math.round(r.rsi * 10) / 10,
                    nv(Math.round(r.obv)),
                    nv(Math.round(r.cmf50 * 10000) / 10000),
                    nv(Math.round(r.cmf20 * 10000) / 10000),
                    nv(r3(r.vwap20)),
                    r3(r.atr14),
                    nv(Math.round(r.rvol20 * 100) / 100),
                    isClosed ? 'True' : 'False',
                ]),
            );
        });
        return lines.join('\r\n') + '\r\n';
    }

    // ---------------- gold_formula.csv ----------------

    private async formulaCsv(
        mode: GoldMode,
        spec: GoldModeSpec,
        withNews: boolean,
        profile: InstrumentProfile = XAUUSD_PROFILE,
    ): Promise<string> {
        const lines: string[] = [this.csvRow(['Section', 'Key', 'Field', 'Value'])];

        // คำเรียกตราสารใน Output 6 — ทองใช้ 'ทอง' (ค่า default เดิม) · คู่เงินใช้ชื่อคู่ตรง ๆ
        const assetName_th = profile.key === 'XAUUSD' ? 'ทอง' : profile.key;
        for (const [key, val] of ANALYSIS_REQUEST(spec, mode, profile.companionBrief_th, assetName_th)) {
            lines.push(this.csvRow(['ANALYSIS_REQUEST', '', key, val]));
        }
        spec.playbook.forEach((play, i) => {
            lines.push(this.csvRow(['ENTRY_PLAYBOOK', '', `${mode} #${i + 1}`, play]));
        });
        for (const [key, val] of profile.sessionMap) {
            lines.push(this.csvRow(['SESSION_MAP', '', key, val]));
        }
        for (const [key, val] of profile.readingGuide('ICMARKETS ผ่าน cTrader Open API')) {
            lines.push(this.csvRow(['READING_GUIDE', '', key, val]));
        }
        if (withNews) {
            for (const n of await this.fetchNews(spec.news, profile)) {
                lines.push(this.csvRow(['LATEST_FINANCIAL_NEWS', '', n.source, `${n.pubDate}, ${n.title}, ${n.link}`]));
            }
        }
        return lines.join('\r\n') + '\r\n';
    }

    // ---------------- news ----------------

    /**
     * on-demand news (2-min cache รวมทุก feed ใช้ร่วมกันทุกตราสาร) — served to Claude via GET /gold/news
     * จัดอันดับตามโปรไฟล์: หัวข้อที่มี keyword ของตราสารมาก่อน (ใหม่→เก่า) แล้วค่อยที่เหลือ (ใหม่→เก่า)
     * ไม่ส่งโปรไฟล์ = จัดอันดับแบบ XAUUSD
     */
    async fetchNews(limit: number, profile: InstrumentProfile = XAUUSD_PROFILE): Promise<NewsItem[]> {
        const items = await this.rawNews();
        return this.rankNews(items, profile).slice(0, limit);
    }

    /** แบบเดียวกับ fetchNews แต่รับโปรไฟล์ก่อน — สะดวกตอนเรียกจาก controller/dashboard */
    fetchNewsFor(profile: InstrumentProfile, limit: number): Promise<NewsItem[]> {
        return this.fetchNews(limit, profile);
    }

    private rankNews(items: RawNewsItem[], profile: InstrumentProfile): NewsItem[] {
        const kws = profile.news.keywords.map((k) => k.toLowerCase());
        const byTsDesc = (a: RawNewsItem, b: RawNewsItem) => b.ts - a.ts;
        const relevant: RawNewsItem[] = [];
        const rest: RawNewsItem[] = [];
        for (const it of items) {
            const t = it.title.toLowerCase();
            (kws.some((k) => t.includes(k)) ? relevant : rest).push(it);
        }
        relevant.sort(byTsDesc);
        rest.sort(byTsDesc);
        // ตัด ts (ใช้เรียงภายใน) ออก — ผู้เรียกเดิมอ่านแค่ source/title/pubDate/link
        const out = (it: RawNewsItem, r: boolean): NewsItem => ({
            source: it.source,
            title: it.title,
            pubDate: it.pubDate,
            link: it.link,
            relevant: r,
        });
        return [...relevant.map((it) => out(it, true)), ...rest.map((it) => out(it, false))];
    }

    /** รายการดิบจากทุก feed — แคช 2 นาที + รวมคำขอที่มาพร้อมกันเป็นรอบเดียว */
    private async rawNews(): Promise<RawNewsItem[]> {
        if (this.newsCache && this.newsCache.expires > Date.now()) return this.newsCache.items;
        if (!this.newsInflight) {
            this.newsInflight = this.fetchNewsFresh()
                .then((items) => {
                    this.newsCache = { expires: Date.now() + 120_000, items };
                    return items;
                })
                .finally(() => {
                    this.newsInflight = null;
                });
        }
        return this.newsInflight;
    }

    private async fetchNewsFresh(): Promise<RawNewsItem[]> {
        const results = await Promise.allSettled(
            ALL_NEWS_FEEDS.map(async (feed) => {
                const parsed = await this.rss.parseURL(feed.url);
                return (parsed.items ?? []).slice(0, 10).map((e) => {
                    // isoDate (rss-parser แปลงให้) เชื่อถือได้กว่า pubDate ดิบ (บาง feed ไม่ใช่ RFC 2822)
                    // สตริงที่ไม่ระบุ timezone (บาง feed เช่น Investing.com) Date.parse จะอ่านเป็น
                    // "เวลาเครื่อง" → เซิร์ฟเวอร์ UTC กับเครื่องไทยได้ผลต่างกัน 7 ชม. ลำดับข่าวเพี้ยน
                    // จึงเติม Z ให้ชัดว่าเป็น UTC เมื่อไม่มีตัวบอกโซนเวลา
                    const rawDate = e.isoDate ?? e.pubDate ?? '';
                    const hasTz = /(Z|[+-]\d{2}:?\d{2}|GMT|UTC|[A-Z]{3,4})\s*$/.test(rawDate.trim());
                    const ts = Date.parse(hasTz || !rawDate ? rawDate : `${rawDate.trim()}Z`);
                    return {
                        source: feed.name,
                        title: e.title ?? '',
                        pubDate: e.pubDate ?? e.isoDate ?? '',
                        link: e.link ?? '',
                        ts: Number.isFinite(ts) ? ts : 0,
                    };
                });
            }),
        );
        const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        if (!items.length) this.logger.warn('news fetch: all feeds failed');
        return items;
    }
}
