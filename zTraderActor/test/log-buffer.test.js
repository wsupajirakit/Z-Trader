import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { channelOf, ORDER_KEYWORDS } from '../src/logging/channels.js';
import { LogBuffer } from '../src/logging/LogBuffer.js';

describe('LogBuffer', () => {
    test('records feed entries with monotonic ids, ISO time and channel', () => {
        const feed = new EventEmitter();
        const buf = new LogBuffer({ now: () => Date.parse('2026-05-01T12:00:00Z') }).attach(feed);
        assert.equal(buf.latestId, 0);
        assert.deepEqual(buf.since(0, 10), []);
        feed.emit('entry', { message: '[Wait] waiting', type: 'info' });
        feed.emit('entry', { message: 'Order Placed: SELL EURUSD', type: 'info' });
        feed.emit('entry', { message: 'oops', type: 'error' });
        assert.equal(buf.latestId, 3);
        assert.deepEqual(buf.since(0, 10), [
            { id: 1, ts: '2026-05-01T12:00:00.000Z', type: 'info', message: '[Wait] waiting', channel: 'system' },
            {
                id: 2,
                ts: '2026-05-01T12:00:00.000Z',
                type: 'info',
                message: 'Order Placed: SELL EURUSD',
                channel: 'order',
            },
            { id: 3, ts: '2026-05-01T12:00:00.000Z', type: 'error', message: 'oops', channel: 'system' },
        ]);
        buf.detach();
        feed.emit('entry', { message: 'after detach', type: 'info' });
        assert.equal(buf.latestId, 3);
    });

    test('keeps only the newest `capacity` entries and pages forward without gaps', () => {
        const buf = new LogBuffer({ capacity: 5 });
        for (let i = 1; i <= 12; i++) buf.push({ message: `line ${i}`, type: 'info' });
        assert.equal(buf.latestId, 12);
        const ids = (after, limit = 100) => buf.since(after, limit).map((e) => e.id);
        assert.deepEqual(ids(0), [8, 9, 10, 11, 12], 'older entries were dropped');
        assert.deepEqual(ids(9), [10, 11, 12]);
        assert.deepEqual(ids(7, 2), [8, 9]);
        assert.deepEqual(ids(12), []);
        assert.deepEqual(ids(99), []);
    });

    test('defaults to 500 entries and caps message length', () => {
        const buf = new LogBuffer();
        for (let i = 0; i < 600; i++) buf.push({ message: 'x', type: 'info' });
        assert.equal(buf.since(0, 1000).length, 500);
        const long = buf.push({ message: 'y'.repeat(10_000), type: 'info' });
        assert.equal(long.message.length, 2000);
        assert.equal(buf.push({ message: 'z', type: 'weird' }).type, 'info');
    });

    test('rejects a non-positive capacity', () => {
        assert.throws(() => new LogBuffer({ capacity: 0 }));
    });
});

describe('channelOf', () => {
    test('uses the order keywords of the original console split', () => {
        assert.ok(ORDER_KEYWORDS.includes('Trade executed'));
        assert.equal(channelOf('Trade executed successfully'), 'order');
        assert.equal(channelOf('[Exec] Conditions met, sending order'), 'order');
        assert.equal(channelOf('BUY XAUUSD'), 'order');
        assert.equal(channelOf('[Think] RSI 55'), 'system');
    });
});
