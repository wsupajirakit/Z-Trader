import type {
  ActivityEntry,
  ActivityLevel,
  ActivityResponse,
} from '../../../api/types';
import { nowTimeTh } from '../../../lib/time';

/** CSS level of a log line (`lv-*` in dashboard.css). */
export type LogLevel = 'info' | 'warn' | 'error' | 'order';

export interface LogLine {
  key: string;
  time: string;
  level: LogLevel;
  tag: string | null;
  message: string;
}

export interface LogState {
  /** Highest server activity id already shown (`lastActivityId` in the original). */
  cursor: number;
  lines: readonly LogLine[];
}

/** The log keeps the last 500 lines, like the original DOM trimming. */
export const MAX_LOG_LINES = 500;
/** On first load, show only the last 25 server lines (`latest_id - 25`). */
export const INITIAL_BACKLOG = 25;

export const EMPTY_LOG: LogState = { cursor: 0, lines: [] };

export function levelOf(level: ActivityLevel): LogLevel {
  if (level === 'error') return 'error';
  if (level === 'ok') return 'order';
  if (level === 'warn') return 'warn';
  return 'info';
}

function cap(lines: readonly LogLine[]): readonly LogLine[] {
  return lines.length > MAX_LOG_LINES
    ? lines.slice(lines.length - MAX_LOG_LINES)
    : lines;
}

/** `pollActivity` of the original as a pure state transition. */
export function ingestActivity(
  state: LogState,
  res: ActivityResponse,
): LogState {
  let cursor = state.cursor;
  if (cursor === 0 && res.latest_id > INITIAL_BACKLOG)
    cursor = res.latest_id - INITIAL_BACKLOG;
  const added: LogLine[] = [];
  for (const e of res.entries) {
    if (e.id <= cursor) continue;
    cursor = e.id;
    added.push(fromServer(e));
  }
  if (!added.length && cursor === state.cursor) return state;
  return { cursor, lines: cap([...state.lines, ...added]) };
}

function fromServer(e: ActivityEntry): LogLine {
  return {
    key: `s${e.id}`,
    time: e.bkk,
    level: levelOf(e.level),
    tag: e.mode,
    message: e.message,
  };
}

/**
 * The System Log: server activity merged with lines the page writes itself (`addLog`), in
 * arrival order. A tiny external store so both the poller and every action can append, and
 * the log survives tab switches and page navigation inside the app.
 */
export class ActivityLog {
  private state: LogState = EMPTY_LOG;
  private readonly listeners = new Set<() => void>();
  private localSeq = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): LogState => this.state;

  get cursor(): number {
    return this.state.cursor;
  }

  ingest(res: ActivityResponse): void {
    this.set(ingestActivity(this.state, res));
  }

  /** `addLog(msg, cls, tag)` of the original. */
  append(
    message: string,
    level: LogLevel = 'info',
    tag: string | null = null,
  ): void {
    const line: LogLine = {
      key: `l${++this.localSeq}`,
      time: nowTimeTh(),
      level,
      tag,
      message,
    };
    this.set({
      cursor: this.state.cursor,
      lines: cap([...this.state.lines, line]),
    });
  }

  private set(next: LogState): void {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}
