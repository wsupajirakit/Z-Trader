/**
 * The cTrader sign-in watchdog, against a local stub server (plain ws on 127.0.0.1):
 *   - a socket whose account is never authorized is dropped and the sign-in retried
 *   - an error answering the sign-in is logged and retried with backoff
 *   - a healthy sign-in stays up (the watchdog is cleared)
 *   - a token-invalidated event ends the session and reconnects
 *
 * Uses dist/ and proto/: npm run build:api && node --test test/ctrader-watchdog.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { WebSocketServer } = require('ws');
const protobuf = require('protobufjs');

const ROOT = path.join(__dirname, '..');
const { CtraderService } = require(path.join(ROOT, 'dist/ctrader/ctrader.service'));

const APP_AUTH_REQ = 2100;
const APP_AUTH_RES = 2101;
const ACCOUNT_AUTH_REQ = 2102;
const ACCOUNT_AUTH_RES = 2103;
const ERROR_RES = 2142;
const TOKEN_INVALIDATED = 2147;

let root;
async function loadRoot() {
    if (root) return root;
    root = new protobuf.Root();
    for (const f of ['OpenApiCommonMessages.proto', 'OpenApiCommonModelMessages.proto', 'OpenApiMessages.proto']) {
        await root.load(path.join(ROOT, 'proto', f), { keepCase: true });
    }
    return root;
}
const frame = (name, payloadType, payload) => {
    const T = root.lookupType(name);
    const PM = root.lookupType('ProtoMessage');
    return PM.encode(PM.create({ payloadType, payload: T.encode(T.create(payload)).finish() })).finish();
};
const decode = (buf) => root.lookupType('ProtoMessage').decode(buf);

/** `reply(ws, payloadType)` decides what the stub answers to each client message */
async function stub(reply) {
    await loadRoot();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const conns = [];
    wss.on('connection', (ws) => {
        conns.push(ws);
        ws.on('message', (buf) => reply(ws, decode(buf).payloadType));
    });
    return {
        conns,
        port: wss.address().port,
        close: () =>
            new Promise((r) => {
                for (const c of wss.clients) c.terminate();
                wss.close(() => r());
            }),
    };
}

function service(port, extra = {}) {
    const cfg = {
        CTRADER_HOST: '127.0.0.1',
        CTRADER_PORT: port,
        CTRADER_ACCOUNT_MODE: 'DEMO',
        APP_ID: 'app',
        APP_SECRET: 'secret',
        DEMO_ACCOUNT_ID: '1',
        ACCESS_TOKEN: 'token',
        CTRADER_AUTH_TIMEOUT_MS: '300',
        CTRADER_RECONNECT_BASE_MS: '50',
        ...extra,
    };
    const svc = new CtraderService({ get: (k, d) => (cfg[k] !== undefined ? cfg[k] : d) }, { emit() {} });
    const errors = [];
    svc.logger = { log() {}, warn() {}, debug() {}, error: (m) => errors.push(String(m)) };
    return { svc, errors };
}

const until = (fn, ms, what) =>
    new Promise((resolve, reject) => {
        const t0 = Date.now();
        const i = setInterval(() => {
            if (fn()) {
                clearInterval(i);
                resolve();
            } else if (Date.now() - t0 > ms) {
                clearInterval(i);
                reject(new Error(`timed out waiting for ${what}`));
            }
        }, 20);
    });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a socket that never gets authorized is dropped and the sign-in retried', async () => {
    const s = await stub(() => {}); // silent server
    const { svc } = service(s.port);
    try {
        await svc.onModuleInit();
        await until(() => s.conns.length >= 3, 3000, 'three connection attempts');
        assert.equal(svc.isAuthorized, false);
    } finally {
        svc.onModuleDestroy();
        await s.close();
    }
});

test('an error answering the sign-in is logged and the sign-in retried (not silently ignored)', async () => {
    const s = await stub((ws, type) => {
        if (type === APP_AUTH_REQ) ws.send(frame('ProtoOAApplicationAuthRes', APP_AUTH_RES, {}));
        if (type === ACCOUNT_AUTH_REQ)
            ws.send(frame('ProtoOAErrorRes', ERROR_RES, { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'expired' }));
    });
    const { svc, errors } = service(s.port, { CTRADER_AUTH_TIMEOUT_MS: '5000' }); // only the error path can retry this fast
    try {
        await svc.onModuleInit();
        await until(() => s.conns.length >= 2, 2000, 'a retry after the auth error');
        assert.equal(svc.isAuthorized, false);
        assert.ok(errors.some((e) => /CH_ACCESS_TOKEN_INVALID/.test(e)), `logged: ${errors.join(' | ')}`);
    } finally {
        svc.onModuleDestroy();
        await s.close();
    }
});

test('a healthy sign-in stays up: the watchdog is cleared, no reconnect', async () => {
    const s = await stub((ws, type) => {
        if (type === APP_AUTH_REQ) ws.send(frame('ProtoOAApplicationAuthRes', APP_AUTH_RES, {}));
        if (type === ACCOUNT_AUTH_REQ) ws.send(frame('ProtoOAAccountAuthRes', ACCOUNT_AUTH_RES, { ctidTraderAccountId: 1 }));
    });
    const { svc } = service(s.port);
    try {
        await svc.onModuleInit();
        await until(() => svc.isAuthorized, 2000, 'authorization');
        await sleep(700); // well past the 300 ms watchdog
        assert.equal(svc.isAuthorized, true);
        assert.equal(s.conns.length, 1);
    } finally {
        svc.onModuleDestroy();
        await s.close();
    }
});

test('a token-invalidated event ends the session and reconnects', async () => {
    const s = await stub((ws, type) => {
        if (type === APP_AUTH_REQ) ws.send(frame('ProtoOAApplicationAuthRes', APP_AUTH_RES, {}));
        if (type === ACCOUNT_AUTH_REQ) ws.send(frame('ProtoOAAccountAuthRes', ACCOUNT_AUTH_RES, { ctidTraderAccountId: 1 }));
    });
    const { svc } = service(s.port);
    try {
        await svc.onModuleInit();
        await until(() => svc.isAuthorized, 2000, 'authorization');
        s.conns[0].send(frame('ProtoOAAccountsTokenInvalidatedEvent', TOKEN_INVALIDATED, { ctidTraderAccountIds: [1], reason: 'revoked' }));
        await until(() => s.conns.length >= 2, 2000, 'a reconnect after the token event');
        await until(() => svc.isAuthorized, 2000, 'a fresh authorization');
    } finally {
        svc.onModuleDestroy();
        await s.close();
    }
});
