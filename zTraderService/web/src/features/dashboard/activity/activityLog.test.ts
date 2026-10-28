import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../../api/types';
import {
  ActivityLog,
  EMPTY_LOG,
  ingestActivity,
  MAX_LOG_LINES,
} from './activityLog';

const entry = (
  id: number,
  over: Partial<ActivityEntry> = {},
): ActivityEntry => ({
  id,
  ts: '2026-10-28T07:00:00Z',
  bkk: '14:00:00',
  level: 'info',
  mode: null,
  message: `m${id}`,
  ...over,
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));

describe('ingestActivity', () => {
  it('first poll shows only the last 25 lines', () => {
    const s = ingestActivity(EMPTY_LOG, {
      latest_id: 100,
      entries: range(41, 100),
    });
    expect(s.cursor).toBe(100);
    expect(s.lines).toHaveLength(25);
    expect(s.lines[0]?.message).toBe('m76');
  });

  it('a short backlog is shown whole', () => {
    const s = ingestActivity(EMPTY_LOG, {
      latest_id: 10,
      entries: range(1, 10),
    });
    expect(s.lines).toHaveLength(10);
  });

  it('later polls append only unseen ids', () => {
    const a = ingestActivity(EMPTY_LOG, { latest_id: 3, entries: range(1, 3) });
    const b = ingestActivity(a, { latest_id: 5, entries: range(2, 5) });
    expect(b.lines.map((l) => l.message)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ]);
    expect(ingestActivity(b, { latest_id: 5, entries: [] })).toBe(b);
  });

  it('maps levels: ok → order (green), error, warn, info', () => {
    const s = ingestActivity(EMPTY_LOG, {
      latest_id: 4,
      entries: [
        entry(1, { level: 'ok' }),
        entry(2, { level: 'error' }),
        entry(3, { level: 'warn', mode: 'XAUUSD/scalp' }),
        entry(4),
      ],
    });
    expect(s.lines.map((l) => [l.level, l.tag])).toEqual([
      ['order', null],
      ['error', null],
      ['warn', 'XAUUSD/scalp'],
      ['info', null],
    ]);
  });
});

describe('ActivityLog store', () => {
  it('interleaves local and server lines in arrival order and keeps 500', () => {
    const log = new ActivityLog();
    let notified = 0;
    log.subscribe(() => notified++);
    log.ingest({ latest_id: 1, entries: [entry(1)] });
    log.append('สั่งรันเอง', 'warn', 'swing');
    log.ingest({ latest_id: 2, entries: [entry(2)] });
    expect(log.getSnapshot().lines.map((l) => l.message)).toEqual([
      'm1',
      'สั่งรันเอง',
      'm2',
    ]);
    expect(notified).toBe(3);

    for (let i = 0; i < MAX_LOG_LINES + 10; i++) log.append(`x${i}`);
    expect(log.getSnapshot().lines).toHaveLength(MAX_LOG_LINES);
    expect(log.cursor).toBe(2);
  });
});
