import { channelOf } from './channels.js';

export const DEFAULT_LOG_CAPACITY = 500;
/** a single runaway line (an inspected object, an upstream error body) must not pin memory */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Ring buffer of the most recent trade-feed lines, for clients that poll instead of holding a
 * socket (zTraderService's dashboard bridge). Ids are monotonic integers starting at 1 and are
 * never reused while the process lives, so `since(lastSeenId)` pages forward without gaps or
 * repeats. After a restart ids start again from 1: a client whose `after` is above `latestId`
 * should start over from 0.
 *
 * Entry: `{ id, ts (ISO), type, message, channel: 'order' | 'system' }`.
 */
export class LogBuffer {
    /**
     * @param {{ capacity?: number, now?: () => number }} [opts]
     */
    constructor({ capacity = DEFAULT_LOG_CAPACITY, now = Date.now } = {}) {
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
        this.capacity = capacity;
        this.now = now;
        /** @type {Array<{ id: number, ts: string, type: string, message: string, channel: 'order' | 'system' }>} */
        this.entries = [];
        this.nextId = 1;
        this.source = null;
        this.onEntry = (entry) => this.push(entry);
    }

    /** Starts recording `entry` events ({ message, type }) from the trade feed. */
    attach(tradeFeed) {
        this.detach();
        this.source = tradeFeed;
        tradeFeed.on('entry', this.onEntry);
        return this;
    }

    detach() {
        this.source?.off('entry', this.onEntry);
        this.source = null;
    }

    /** @param {{ message: unknown, type?: unknown }} entry */
    push({ message, type } = {}) {
        const text = String(message ?? '').slice(0, MAX_MESSAGE_LENGTH);
        const entry = {
            id: this.nextId++,
            ts: new Date(this.now()).toISOString(),
            type: type === 'error' ? 'error' : 'info',
            message: text,
            channel: channelOf(text),
        };
        this.entries.push(entry);
        if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
        return entry;
    }

    /** Id of the newest entry, 0 when nothing was logged yet. */
    get latestId() {
        return this.nextId - 1;
    }

    /**
     * Entries with id > after, oldest first, at most `limit` of them.
     * @param {number} after
     * @param {number} limit
     */
    since(after, limit) {
        if (this.entries.length === 0) return [];
        const firstId = this.entries[0].id;
        const start = Math.max(0, after - firstId + 1);
        return this.entries.slice(start, start + limit);
    }
}
