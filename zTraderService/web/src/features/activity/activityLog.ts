import type {
  ActivityEntry,
  ActivityLevel,
  ActivityResponse,
} from '../../api/types';

export type LogLevel = 'info' | 'warn' | 'error' | 'order';

export interface LogLine {
  key: string;
  time: string;
  level: LogLevel;
  tag: string | null;
  message: string;
}

export interface LogState {
  /** highest server activity id already shown */
  cursor: number;
  lines: readonly LogLine[];
}

export const MAX_LOG_LINES = 500;
/** on first load show only the last 25 server lines */
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

export function nowTime(now: Date = new Date()): string {
  return now.toLocaleTimeString('en-GB', { hour12: false });
}

/** merge a server activity page into the log */
export function ingestActivity(
  state: LogState,
  res: ActivityResponse,
): LogState {
  let cursor = state.cursor;
  if (cursor === 0 && res.latest_id > INITIAL_BACKLOG)
    cursor = res.latest_id - INITIAL_BACKLOG;
  // the server restarted (ids begin again): start over from its backlog
  if (res.latest_id < cursor)
    cursor = Math.max(0, res.latest_id - INITIAL_BACKLOG);
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

/** server activity merged with lines the page writes itself, in arrival order */
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

  append(
    message: string,
    level: LogLevel = 'info',
    tag: string | null = null,
  ): void {
    const line: LogLine = {
      key: `l${++this.localSeq}`,
      time: nowTime(),
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
