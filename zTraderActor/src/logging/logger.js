import { EventEmitter } from 'node:events';
import { inspect, stripVTControlCharacters } from 'node:util';

/**
 * Two loggers with different audiences:
 *
 * - `log` is the system log (HTTP, auth, boot). It goes to stdout/stderr only and is
 *   never shown on the dashboard, because it can contain usernames and IPs.
 * - `tradeLog` is the strategy feed. It prints exactly what the old console.log /
 *   process.stdout.write calls printed, and additionally emits an `entry` event on
 *   `tradeFeed`, which the realtime layer forwards to authenticated sockets only.
 *
 * This replaces the previous global monkey-patching of console and process.stdout.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let level = LEVELS.info;

export function setLogLevel(name) {
    if (!(name in LEVELS)) throw new Error(`unknown log level ${name}`);
    level = LEVELS[name];
}

function write(lvl, stream, args) {
    if (LEVELS[lvl] > level) return;
    stream.write(`${new Date().toISOString()} ${lvl.toUpperCase()} ${formatArgs(args)}\n`);
}

export const log = Object.freeze({
    error: (...args) => write('error', process.stderr, args),
    warn: (...args) => write('warn', process.stderr, args),
    info: (...args) => write('info', process.stdout, args),
    debug: (...args) => write('debug', process.stdout, args),
});

/** Format for the dashboard: Error -> message only (no stack traces or file paths). */
export function formatArgs(args) {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.message;
            return inspect(a, { depth: 3, breakLength: Infinity, colors: false });
        })
        .join(' ');
}

export const tradeFeed = new EventEmitter();

// Status lines written with stdout.write were only forwarded when they carried one of these tags.
const STATUS_TAGS = ['[Think]', '[Wait]', '[Exec]'];

export const tradeLog = Object.freeze({
    info(...args) {
        console.log(...args);
        tradeFeed.emit('entry', { message: formatArgs(args), type: 'info' });
    },
    error(...args) {
        console.error(...args);
        tradeFeed.emit('entry', { message: formatArgs(args), type: 'error' });
    },
    /** In-place status line (\r / ANSI clear-line), like the old process.stdout.write calls. */
    status(chunk) {
        process.stdout.write(chunk);
        if (STATUS_TAGS.some((tag) => chunk.includes(tag))) {
            tradeFeed.emit('entry', { message: stripVTControlCharacters(chunk).trim(), type: 'info' });
        }
    },
});
