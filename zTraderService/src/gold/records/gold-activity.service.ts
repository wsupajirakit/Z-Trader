import { Injectable } from '@nestjs/common';
import { demoContext } from '../../common/demo/demo-context';

export interface ActivityEntry {
    id: number;
    ts: string; // ISO UTC
    bkk: string; // HH:mm:ss Bangkok
    level: 'info' | 'ok' | 'warn' | 'error';
    mode: string | null;
    message: string;
}

/**
 * In-memory ring buffer of what the gold bot is doing, polled by the dashboard
 * (GET /gold/activity?after=<id>) so the user always sees live activity.
 */
@Injectable()
export class GoldActivityService {
    private readonly max = 400;
    private entries: ActivityEntry[] = [];
    private nextId = 1;

    push(level: ActivityEntry['level'], message: string, mode: string | null = null): ActivityEntry {
        if (demoContext.active) message = `[DEMO ${demoContext.username ?? ''}] ${message}`;
        const now = new Date();
        const e: ActivityEntry = {
            id: this.nextId++,
            ts: now.toISOString(),
            bkk: now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }),
            level,
            mode,
            message,
        };
        this.entries.push(e);
        if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
        return e;
    }

    since(afterId: number, limit = 100): ActivityEntry[] {
        return this.entries.filter((e) => e.id > afterId).slice(-limit);
    }

    latestId(): number {
        return this.nextId - 1;
    }
}
