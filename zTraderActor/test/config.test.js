import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../src/config/env.js';

const base = { API_TRADER_URL: 'http://svc:6500/', API_KEY: 'k'.repeat(32) };

describe('loadConfig', () => {
    test('defaults', () => {
        const c = loadConfig(base);
        assert.equal(c.service.url, 'http://svc:6500', 'trailing slash removed');
        assert.equal(c.port, 3000);
        assert.equal(c.trustProxy, 0);
        assert.deepEqual(c.trading, {
            symbols: ['XAUUSD'],
            mode: 'Sonic',
            maxPositions: 1,
            tradeAmountUsd: 10,
            tradeLotSize: null,
        });
        assert.ok(Object.isFrozen(c));
    });

    test('parses all supported variables', () => {
        const c = loadConfig({
            ...base,
            PORT: '8080',
            TRUST_PROXY: '1',
            SYMBOL: 'XAUUSD, EURUSD',
            STRATEGY_MODE: 'scalper',
            MAX_POSITIONS: '3',
            TRADE_AMOUNT_USD: '25.5',
            TRADE_LOT_SIZE: '0.05',
        });
        assert.equal(c.port, 8080);
        assert.equal(c.trustProxy, 1);
        assert.deepEqual(c.trading.symbols, ['XAUUSD', 'EURUSD']);
        assert.equal(c.trading.mode, 'Scalper');
        assert.equal(c.trading.tradeLotSize, 0.05);
    });

    test('collects every problem into one ConfigError', () => {
        assert.throws(
            () =>
                loadConfig({
                    API_KEY: 'short',
                    PORT: 'eighty',
                    TRUST_PROXY: '-1',
                    MAX_POSITIONS: '1.5',
                    TRADE_AMOUNT_USD: 'lots',
                    STRATEGY_MODE: 'yolo',
                    SYMBOL: 'xau/usd',
                }),
            (err) => {
                assert.ok(err instanceof ConfigError);
                const text = err.problems.join('\n');
                for (const name of [
                    'API_TRADER_URL',
                    'API_KEY must be at least 32',
                    'PORT',
                    'TRUST_PROXY',
                    'MAX_POSITIONS',
                    'TRADE_AMOUNT_USD',
                    'STRATEGY_MODE',
                    'SYMBOL',
                ]) {
                    assert.ok(text.includes(name), `mentions ${name}`);
                }
                return true;
            },
        );
    });

    test('rejects non-http service URLs', () => {
        assert.throws(() => loadConfig({ ...base, API_TRADER_URL: 'file:///etc/passwd' }), ConfigError);
        assert.throws(() => loadConfig({ ...base, API_TRADER_URL: 'not a url' }), ConfigError);
    });
});

test('server exits with a clear message when the environment is invalid', () => {
    const server = fileURLToPath(new URL('../src/server.js', import.meta.url));
    const r = spawnSync(process.execPath, [server], {
        env: { PATH: process.env.PATH, API_KEY: 'short' },
        encoding: 'utf8',
        timeout: 10_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Invalid configuration/);
    assert.match(r.stderr, /API_TRADER_URL is required/);
    assert.doesNotMatch(r.stderr, /short/, 'secret values are not echoed');
});
