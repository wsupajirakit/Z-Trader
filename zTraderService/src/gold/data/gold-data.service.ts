import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { EnrichedBar } from '../domain/indicators';
import type { InstrumentKey } from '../domain/instruments';

export type GoldMode = 'scalp' | 'intraday' | 'swing' | 'position';

export interface GoldExport {
    mode: GoldMode;
    files: Map<string, string>; // filename -> text content
    formula: string; // gold_formula.csv
    errors: string | null; // _errors.txt content (null = all companions ok)
    cacheHit: boolean;
    /** enriched bars per `${symbol}_${tf}` (lowercase) — set by the local builder */
    series?: Record<string, EnrichedBar[]>;
    /** ตราสารที่ชุดข้อมูลนี้สร้างให้ (XAUUSD/EURUSD/…) — set by the local builder; ไม่มี = XAUUSD (ZIP pull เดิม) */
    instrument?: InstrumentKey;
}

@Injectable()
export class GoldDataService {
    private readonly logger = new Logger(GoldDataService.name);

    constructor(private configService: ConfigService) {}

    /**
     * Pull gold_<mode>.zip from z-service /api/gold/export (see XAU_AUTOMATE.md).
     * Throws on 401/400/502 — a 502 means XAUUSD could not be fetched at all
     * and the caller MUST skip trading this round.
     */
    async fetchExport(mode: GoldMode): Promise<GoldExport> {
        const baseUrl = this.configService.get<string>('GOLD_EXPORT_BASE_URL', '').replace(/\/+$/, '');
        const pullKey = this.configService.get<string>('GOLD_PULL_KEY');
        if (!baseUrl) throw new Error('GOLD_EXPORT_BASE_URL is not configured (needed for GOLD_DATA_SOURCE=remote)');
        if (!pullKey) throw new Error('GOLD_PULL_KEY is not configured');

        const res = await axios.get(`${baseUrl}/api/gold/export`, {
            params: { mode },
            headers: { 'X-Pull-Key': pullKey },
            responseType: 'arraybuffer',
            timeout: 180_000,
            validateStatus: () => true,
        });

        if (res.status === 401) throw new Error('gold/export 401: X-Pull-Key rejected');
        if (res.status === 400) throw new Error(`gold/export 400: invalid mode "${mode}"`);
        if (res.status === 502)
            throw new Error('gold/export 502: XAUUSD unavailable on all TFs — DO NOT TRADE this round');
        if (res.status !== 200) throw new Error(`gold/export unexpected HTTP ${res.status}`);

        const zip = new AdmZip(Buffer.from(res.data));
        const files = new Map<string, string>();
        for (const entry of zip.getEntries()) {
            if (!entry.isDirectory) {
                files.set(entry.entryName, entry.getData().toString('utf8'));
            }
        }

        const formula = files.get('gold_formula.csv');
        if (!formula) throw new Error('gold/export: gold_formula.csv missing from ZIP');

        return {
            mode,
            files,
            formula,
            errors: files.get('_errors.txt') ?? null,
            cacheHit: String(res.headers['x-gold-cache'] ?? '').toLowerCase() === 'hit',
        };
    }
}
