/**
 * Chart data API (/api/chart, session only): sources per symbol, validation, bars from a stubbed
 * TradingView client (no network), the 5 s bars cache, and the SSE stream with its shared,
 * ref-counted upstream feed. cTrader is unreachable here, so the broker source reports 503 / a
 * reconnecting status.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ADMIN, API_KEY, startApp, type TestApp } from './helpers/app.mts';

let t: TestApp;
before(async () => {
    t = await startApp();
    // the SSE tests use a raw http client, so the server needs a real port (supertest reuses it)
    await new Promise<void>((resolve) => t.server.listen(0, '127.0.0.1', resolve));
    await t.resetData();
});
after(async () => {
    await t.close();
});

const tvClient = () => t.get<any>('integrations/tradingview/tv-client.js#TradingViewClient');
const chartService = () => t.get<any>('chart/chart.service.js#ChartService');

const restores: Array<() => void> = [];
function patch<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const old = obj[key];
    obj[key] = value;
    restores.push(() => {
        if (had) obj[key] = old;
        else delete obj[key];
    });
}
afterEach(() => {
    while (restores.length) restores.pop()!();
});

async function login(): Promise<{ agent: ReturnType<typeof request.agent>; cookie: string }> {
    const agent = request.agent(t.server);
    const res = await agent.post('/api/auth/login').send(ADMIN).expect(200);
    const cookie = ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');
    return { agent, cookie };
}

function fakeBars(n: number, start = 1_793_000_000, step = 300) {
    return Array.from({ length: n }, (_, i) => ({
        time: start + i * step,
        open: 4000 + i,
        high: 4001 + i,
        low: 3999 + i,
        close: 4000.5 + i,
        volume: 10 + i,
    }));
}

/** a stand-in for TvSeries: history right away, then one live update */
function fakeSeries(log: string[], full: string) {
    const s = new EventEmitter() as EventEmitter & { close(): void };
    s.close = () => log.push(`close ${full}`);
    setImmediate(() => {
        s.emit('history', fakeBars(2));
        setTimeout(() => s.emit('bar', { ...fakeBars(2)[1], close: 4999, volume: 99 }), 20);
    });
    return s;
}

interface SseResult {
    status: number;
    headers: http.IncomingHttpHeaders;
    text: string;
}

/** open an SSE stream and read until `done(text)` is true (or the timeout), then hang up */
function sse(path: string, cookie: string, done: (text: string) => boolean, timeoutMs = 5_000): Promise<SseResult> {
    const { port } = t.server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
        const req = http.get({
            host: '127.0.0.1',
            port,
            path,
            headers: { Cookie: cookie, Accept: 'text/event-stream' },
        });
        const timer = setTimeout(() => {
            req.destroy();
            reject(new Error(`SSE ${path}: condition not met in ${timeoutMs} ms`));
        }, timeoutMs);
        req.on('response', (res) => {
            let text = '';
            const finish = () => {
                clearTimeout(timer);
                req.destroy();
                resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
            };
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                text += chunk;
                if (done(text)) finish();
            });
            res.on('end', finish);
        });
        req.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}

function events(text: string, name: string): any[] {
    return text
        .split('\n\n')
        .map((block) => block.split('\n'))
        .filter((lines) => lines.includes(`event: ${name}`))
        .map((lines) => JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)));
}

const waitFor = async (cond: () => boolean, ms = 2_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 20));
    }
};

describe('authentication', () => {
    it('every chart route needs a session: 401 without one', async () => {
        for (const path of [
            '/api/chart/sources?symbol=XAUUSD',
            '/api/chart/bars?symbol=XAUUSD&source=tv:OANDA&tf=M5',
            '/api/chart/stream?symbol=XAUUSD&source=tv:OANDA&tf=M5',
        ]) {
            await request(t.server).get(path).expect(401);
        }
    });

    it('the machine API key is not a session', async () => {
        await request(t.server).get('/api/chart/sources?symbol=XAUUSD').set('x-api-key', API_KEY).expect(401);
    });
});

describe('GET /api/chart/sources', () => {
    it('lists cTrader first, then the TradingView exchanges of the symbol', async () => {
        const { agent } = await login();
        const res = await agent.get('/api/chart/sources?symbol=xauusd').expect(200);
        assert.equal(res.body.symbol, 'XAUUSD');
        assert.deepEqual(res.body.sources[0], { id: 'ctrader', label: 'cTrader (account broker)', kind: 'broker' });
        assert.deepEqual(
            res.body.sources.slice(1).map((s: any) => s.id),
            [
                'tv:OANDA',
                'tv:PEPPERSTONE',
                'tv:CAPITALCOM',
                'tv:VANTAGE',
                'tv:ICMARKETS',
                'tv:EIGHTCAP',
                'tv:FOREXCOM',
                'tv:BLACKBULL',
            ],
        );
        for (const s of res.body.sources.slice(1)) {
            assert.equal(s.kind, 'tradingview');
            assert.equal(typeof s.label, 'string');
            assert.deepEqual(Object.keys(s as object).sort(), ['id', 'kind', 'label']);
        }
    });

    it('FX pairs get their own verified exchange list', async () => {
        const { agent } = await login();
        for (const symbol of ['EURUSD', 'GBPUSD', 'USDJPY']) {
            const res = await agent.get(`/api/chart/sources?symbol=${symbol}`).expect(200);
            const ids = (res.body.sources as Array<{ id: string }>).map((s) => s.id);
            assert.equal(ids[0], 'ctrader');
            assert.ok(ids.includes('tv:OANDA') && ids.includes('tv:FX_IDC'), ids.join(','));
            assert.ok(!ids.includes('tv:FXCM'), 'FXCM returned no bars when probed');
        }
    });

    it('400 for a missing or unknown symbol', async () => {
        const { agent } = await login();
        await agent.get('/api/chart/sources').expect(400);
        const res = await agent.get('/api/chart/sources?symbol=BTCUSD').expect(400);
        assert.match(JSON.stringify(res.body.message), /symbol must be one of/);
    });
});

describe('GET /api/chart/bars', () => {
    it('validates symbol, source, tf and limit', async () => {
        const { agent } = await login();
        const bad = [
            '/api/chart/bars?symbol=BTCUSD&source=tv:OANDA&tf=M5',
            '/api/chart/bars?symbol=XAUUSD&source=tv:NOPE&tf=M5',
            '/api/chart/bars?symbol=XAUUSD&source=tv:OANDA&tf=M7',
            '/api/chart/bars?symbol=XAUUSD&tf=M5',
            '/api/chart/bars?symbol=XAUUSD&source=tv:OANDA&tf=M5&limit=10',
            '/api/chart/bars?symbol=XAUUSD&source=tv:OANDA&tf=M5&limit=5000',
            '/api/chart/bars?symbol=XAUUSD&source=tv:OANDA&tf=M5&limit=abc',
            // a real exchange, but not offered for this pair
            '/api/chart/bars?symbol=EURUSD&source=tv:VANTAGE&tf=M5',
        ];
        for (const path of bad) await agent.get(path).expect(400);
    });

    it('returns bars from TradingView in the documented shape', async () => {
        const calls: unknown[][] = [];
        patch(tvClient(), 'fetchBars', (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve(fakeBars(600));
        });
        const { agent } = await login();
        const res = await agent.get('/api/chart/bars?symbol=XAUUSD&source=tv:pepperstone&tf=h1&limit=100').expect(200);
        assert.deepEqual(Object.keys(res.body as object).sort(), ['bars', 'source', 'symbol', 'tf']);
        assert.equal(res.body.symbol, 'XAUUSD');
        assert.equal(res.body.source, 'tv:PEPPERSTONE');
        assert.equal(res.body.tf, 'H1');
        assert.equal(res.body.bars.length, 100);
        assert.deepEqual(Object.keys(res.body.bars[0] as object).sort(), [
            'close',
            'high',
            'low',
            'open',
            'time',
            'volume',
        ]);
        assert.equal(res.body.bars[99].time, fakeBars(600)[599].time, 'the newest bars are returned');
        assert.deepEqual(calls, [['PEPPERSTONE:XAUUSD', '60', 100]]);
    });

    it('defaults limit to 500 and reuses a fresh answer for the same symbol/source/tf', async () => {
        let n = 0;
        patch(tvClient(), 'fetchBars', (_full: string, _iv: string, limit: number) => {
            n++;
            return Promise.resolve(fakeBars(limit));
        });
        const { agent } = await login();
        const a = await agent.get('/api/chart/bars?symbol=USDJPY&source=tv:SAXO&tf=D1').expect(200);
        assert.equal(a.body.bars.length, 500);
        const b = await agent.get('/api/chart/bars?symbol=USDJPY&source=tv:SAXO&tf=D1&limit=50').expect(200);
        assert.equal(b.body.bars.length, 50);
        assert.equal(n, 1, 'second call served from the cache');
        // a bigger limit than the cached one is fetched again
        await agent.get('/api/chart/bars?symbol=USDJPY&source=tv:SAXO&tf=D1&limit=800').expect(200);
        assert.equal(n, 2);
    });

    it('a TradingView failure is a 502 and is not cached', async () => {
        let n = 0;
        patch(tvClient(), 'fetchBars', () => {
            n++;
            return Promise.reject(new Error('timed out after 20 s'));
        });
        const { agent } = await login();
        const res = await agent.get('/api/chart/bars?symbol=GBPUSD&source=tv:OANDA&tf=M15').expect(502);
        assert.match(String(res.body.message), /TradingView did not return data for OANDA:GBPUSD/);
        await agent.get('/api/chart/bars?symbol=GBPUSD&source=tv:OANDA&tf=M15').expect(502);
        assert.equal(n, 2);
    });

    it('cTrader source answers 503 while the broker is not connected', async () => {
        const { agent } = await login();
        const res = await agent.get('/api/chart/bars?symbol=XAUUSD&source=ctrader&tf=M5').expect(503);
        assert.match(String(res.body.message), /cTrader is not connected/);
    });
});

describe('GET /api/chart/stream (SSE)', () => {
    it('400 for a bad query, as JSON, before any stream starts', async () => {
        const { agent } = await login();
        await agent.get('/api/chart/stream?symbol=XAUUSD&source=tv:OANDA&tf=W1').expect(400);
        await agent.get('/api/chart/stream?symbol=EURUSD&source=tv:BLACKBULL&tf=M5').expect(400);
    });

    it('streams status and bar events from one shared upstream subscription', async () => {
        const log: string[] = [];
        let subscribes = 0;
        patch(tvClient(), 'subscribe', (full: string, interval: string, n: number) => {
            subscribes++;
            log.push(`subscribe ${full} ${interval} ${n}`);
            return fakeSeries(log, full);
        });
        const { cookie } = await login();
        const path = '/api/chart/stream?symbol=XAUUSD&source=tv:OANDA&tf=M5';
        const first = await sse(path, cookie, (txt) => events(txt, 'bar').some((b) => b.close === 4999));

        assert.equal(first.status, 200);
        assert.match(String(first.headers['content-type']), /^text\/event-stream/);
        assert.equal(first.headers['cache-control'], 'no-store');
        assert.equal(first.headers['x-accel-buffering'], 'no');
        const statuses = events(first.text, 'status');
        assert.ok(
            statuses.some((s) => s.state === 'live'),
            first.text,
        );
        const bars = events(first.text, 'bar');
        assert.deepEqual(Object.keys(bars[0] as object).sort(), ['close', 'high', 'low', 'open', 'time', 'volume']);
        assert.equal(bars[0].time, fakeBars(2)[1].time);

        // a second viewer joins the same feed and immediately gets the latest bar, no new upstream
        const second = await sse(path, cookie, (txt) => events(txt, 'bar').length > 0);
        assert.equal(events(second.text, 'bar')[0].close, 4999);
        assert.equal(subscribes, 1, log.join(' | '));
        assert.deepEqual(log[0], 'subscribe OANDA:XAUUSD 5 2');

        // both left: the feed stays open (idle grace period) with no viewers
        await waitFor(() =>
            chartService()
                .feedStats()
                .some((f: any) => f.key === 'XAUUSD|tv:OANDA|M5' && f.viewers === 0),
        );
        assert.ok(!log.includes('close OANDA:XAUUSD'), 'upstream not closed during the grace period');
    });

    it('the cTrader source reports reconnecting while the broker is down', async () => {
        const { cookie } = await login();
        const res = await sse('/api/chart/stream?symbol=EURUSD&source=ctrader&tf=M1', cookie, (txt) =>
            events(txt, 'status').some((s) => s.message === 'cTrader is not connected'),
        );
        assert.equal(res.status, 200);
        assert.deepEqual(events(res.text, 'status').at(-1), {
            state: 'reconnecting',
            message: 'cTrader is not connected',
        });
    });
});
