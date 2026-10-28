import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { ServiceClient, ServiceError } from '../src/services/ServiceClient.js';
import { ORDER_ACTOR, TradeDispatcher } from '../src/services/TradeDispatcher.js';
import { TradingEngine } from '../src/services/TradingEngine.js';
import { tradeFeed } from '../src/logging/logger.js';
import { startStubService, STUB_API_KEY } from './helpers/stubService.js';

describe('ServiceClient (axios replacement) error mapping', () => {
    let stub;
    before(async () => {
        stub = await startStubService();
    });
    after(() => stub.close());

    test('2xx resolves with parsed JSON; query params skip null/undefined', async () => {
        const api = new ServiceClient({ baseUrl: stub.url, apiKey: STUB_API_KEY });
        assert.deepEqual(await api.get('/gold/activity', { query: { after: 5, x: undefined, y: null } }), {
            latest_id: 0,
            entries: [],
        });
        assert.equal(stub.requests.at(-1).search, '?after=5');
    });

    test('non-2xx rejects with ServiceError { status, data } like axios error.response', async () => {
        const api = new ServiceClient({ baseUrl: stub.url, apiKey: 'wrong' });
        const err = await api.get('/gold/status').catch((e) => e);
        assert.ok(err instanceof ServiceError);
        assert.equal(err.status, 401);
        assert.equal(err.data.message, 'bad api key');
        assert.equal(err.message, 'Request failed with status code 401');
    });

    test('connection refused keeps code ECONNREFUSED', async () => {
        const srv = createServer();
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        const { port } = srv.address();
        await new Promise((r) => srv.close(r));
        const api = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' });
        const err = await api.get('/x').catch((e) => e);
        assert.equal(err.code, 'ECONNREFUSED');
    });

    test('timeouts reject with code ETIMEDOUT', async () => {
        const sockets = new Set();
        const hang = createServer((sock) => sockets.add(sock)); // accepts, never answers
        await new Promise((r) => hang.listen(0, '127.0.0.1', r));
        const api = new ServiceClient({ baseUrl: `http://127.0.0.1:${hang.address().port}`, apiKey: 'k' });
        const err = await api.get('/x', { timeoutMs: 50 }).catch((e) => e);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.message, 'timeout of 50ms exceeded');
        sockets.forEach((sock) => sock.destroy());
        await new Promise((r) => hang.close(r));
    });
});

describe('TradeDispatcher order payload', () => {
    let stub;
    before(async () => {
        stub = await startStubService();
    });
    after(() => stub.close());

    test("the loop's orders pass the service DTO: no accountId or unitsPerLot, X-Actor-User actor-loop", async () => {
        const api = new ServiceClient({ baseUrl: stub.url, apiKey: STUB_API_KEY });
        const dispatcher = new TradeDispatcher(api, { tradeLotSize: null, tradeAmountUsd: 10 });
        const quiet = () => {};
        const [origLog, origWrite] = [console.log, process.stdout.write];
        console.log = quiet;
        process.stdout.write = () => true;
        tradeFeed.on('entry', quiet);
        try {
            const res = await dispatcher.executeTrade({
                symbol: 'XAUUSD',
                volume: 0.04,
                side: 'BUY',
                orderType: 'STOP',
                price: 2400.2,
                stopLoss: 2398.2,
                takeProfit: 2402.7,
                comment: 'Conservative-BUY-STOP',
            });
            assert.equal(res.ok, true);
        } finally {
            console.log = origLog;
            process.stdout.write = origWrite;
            tradeFeed.off('entry', quiet);
        }
        const [call] = stub.calls('/orders');
        assert.equal(call.headers['x-actor-user'], ORDER_ACTOR);
        assert.equal(ORDER_ACTOR, 'actor-loop');
        assert.ok(!('accountId' in call.body));
        assert.ok(!('unitsPerLot' in call.body));
        assert.equal(call.body.volume, 0.04);
        assert.match(call.body.uuid, /^[0-9a-f-]{36}$/);
    });
});

describe('TradingEngine with a stub strategy and feed', () => {
    class StubFeed extends EventEmitter {
        connect() {}
        close() {}
    }

    test('start/stop, per-symbol run, market updates', async () => {
        const runs = [];
        const strategy = {
            mode: null,
            setMode(m) {
                this.mode = m;
            },
            async run(symbol, period, maxPositions) {
                runs.push([symbol, period, maxPositions]);
            },
        };
        const feed = new StubFeed();
        const engine = new TradingEngine({
            strategy,
            marketFeed: feed,
            trading: { symbols: ['XAUUSD'], mode: 'Sonic', maxPositions: 2 },
        });
        const quiet = () => {};
        tradeFeed.on('entry', quiet);
        const origLog = console.log;
        console.log = quiet; // engine prints its status lines
        try {
            engine.init();
            const states = [];
            engine.on('state', (s) => states.push(s));
            engine.start(['XAUUSD', 'EURUSD'], 'Scalper');
            await new Promise((r) => setImmediate(r));
            assert.equal(strategy.mode, 'Scalper');
            assert.deepEqual(runs, [
                ['XAUUSD', undefined, 2],
                ['EURUSD', undefined, 2],
            ]);
            assert.deepEqual(states.at(-1), { isRunning: true, symbols: ['XAUUSD', 'EURUSD'], mode: 'Scalper' });

            const market = [];
            engine.on('market', (m) => market.push(m));
            feed.emit('indicators', { symbol: 'XAUUSD', bid: 2400.5, rsi: 55 });
            feed.emit('indicators', { symbol: 'GBPUSD', bid: 1.3 }); // not watched
            assert.deepEqual(market, [{ symbol: 'XAUUSD', price: 2400.5, rsi: 55 }]);

            engine.stop();
            assert.equal(states.at(-1).isRunning, false);
            assert.equal(engine.loopInterval, null);
        } finally {
            engine.close();
            console.log = origLog;
            tradeFeed.off('entry', quiet);
        }
    });
});
