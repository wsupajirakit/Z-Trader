import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { GoldMode } from '../data/gold-data.service';
import { errorMessage } from '../../common/utils/errors';
import { DomainError } from '../domain/domain-error';

const fsp = fs.promises;

/**
 * Keeps a JSON history of every gold round under ./archive/<mode>/ —
 * filename carries Bangkok local time, payload carries both UTC and Bangkok.
 * e.g. archive/swing/20260804_091530_swing.json
 */
@Injectable()
export class GoldArchiveService {
    private readonly logger = new Logger(GoldArchiveService.name);

    constructor(private configService: ConfigService) {}

    private baseDir(): string {
        return path.resolve(this.configService.get<string>('GOLD_ARCHIVE_DIR', './archive'));
    }

    save(mode: GoldMode, payload: Record<string, any>): string | null {
        try {
            const now = new Date();
            const bkk = now.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }); // "YYYY-MM-DD HH:mm:ss"
            const stamp = bkk.replace(/[-:]/g, '').replace(' ', '_');
            const dir = path.join(this.baseDir(), mode);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${stamp}_${mode}.json`);
            fs.writeFileSync(
                file,
                JSON.stringify(
                    {
                        generated_utc: now.toISOString(),
                        generated_bangkok: bkk,
                        mode,
                        ...payload,
                    },
                    null,
                    1,
                ),
            );
            this.logger.log(`archived ${path.relative(process.cwd(), file)}`);
            return file;
        } catch (e) {
            this.logger.error(`archive save failed: ${errorMessage(e)}`);
            return null;
        }
    }

    /**
     * Newest first. Filenames start with a timestamp, so the names alone give the order: only the
     * top `limit` files are stat'ed and peeked, however many rounds the archive holds.
     */
    async list(
        mode?: GoldMode,
        limit = 50,
    ): Promise<Array<{ file: string; mode: string; size: number; mtime: string; outcome: string }>> {
        const base = this.baseDir();
        const modes = mode ? [mode] : await this.readdirOrEmpty(base);
        const names: string[] = [];
        for (const m of modes) {
            for (const f of await this.readdirOrEmpty(path.join(base, m))) {
                if (f.endsWith('.json')) names.push(`${m}/${f}`);
            }
        }
        names.sort((a, b) => b.localeCompare(a));
        const rows = await Promise.all(
            names.slice(0, Math.max(0, limit)).map(async (rel) => {
                const full = path.join(base, rel);
                try {
                    const st = await fsp.stat(full);
                    if (!st.isFile()) return null;
                    return {
                        file: rel,
                        mode: rel.slice(0, rel.indexOf('/')),
                        size: st.size,
                        mtime: st.mtime.toISOString(),
                        outcome: await this.peekOutcome(full),
                    };
                } catch {
                    return null; // removed between readdir and stat
                }
            }),
        );
        return rows.filter((r): r is NonNullable<typeof r> => r !== null);
    }

    /** a missing (or non-directory) path lists as empty */
    private async readdirOrEmpty(dir: string): Promise<string[]> {
        try {
            return await fsp.readdir(dir);
        } catch {
            return [];
        }
    }

    /** อ่านแค่หัวไฟล์เพื่อดึง outcome (ไฟล์เต็มใหญ่หลายร้อย KB) */
    private async peekOutcome(full: string): Promise<string> {
        let fh: fs.promises.FileHandle | undefined;
        try {
            fh = await fsp.open(full, 'r');
            const buf = Buffer.alloc(2048);
            const { bytesRead } = await fh.read(buf, 0, 2048, 0);
            const m = buf
                .subarray(0, bytesRead)
                .toString('utf8')
                .match(/"outcome":\s*"((?:[^"\\]|\\.)*)"/);
            return m ? m[1].replace(/\\"/g, '"') : '?';
        } catch {
            return '?';
        } finally {
            await fh?.close().catch(() => undefined);
        }
    }

    /**
     * @param full true = ทั้งไฟล์รวมแท่งย้อนหลัง · false = สรุปอ่านง่าย (ตัด series_tail)
     * A missing file is a 404 with a generic message: the absolute path must not reach the caller.
     */
    async read(relFile: string, includeSeries = false): Promise<any> {
        // guard against path traversal — resolve inside baseDir only
        const abs = path.resolve(this.baseDir(), relFile);
        if (!abs.startsWith(this.baseDir() + path.sep)) throw new DomainError('invalid archive path');
        let text: string;
        try {
            text = await fsp.readFile(abs, 'utf8');
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
                throw new NotFoundException('archive file not found');
            }
            throw e;
        }
        const data = JSON.parse(text);
        if (includeSeries) return data;
        const { series_tail, ...summary } = data;
        return {
            ...summary,
            series_tail_omitted: series_tail
                ? `${Object.keys(series_tail).length} series (เพิ่ม ?full=1 เพื่อดูแท่งย้อนหลัง)`
                : undefined,
        };
    }
}
