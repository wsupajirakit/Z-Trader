import { createServer } from 'node:http';

export const STUB_API_KEY = 'test-api-key-0123456789abcdef0123456789';

/** Users known to the stub. Password for all of them: PASSWORD. */
export const PASSWORD = 'correct horse battery staple';
const USERS = {
    olivia: { id: 'u-op', username: 'olivia', name: 'Olivia Operator', role: 'operator' },
    victor: { id: 'u-view', username: 'victor', name: 'Victor Viewer', role: 'viewer' },
    adam: { id: 'u-admin', username: 'adam', name: 'Adam Admin', role: 'admin' },
    newbie: { id: 'u-new', username: 'newbie', name: 'New User', role: 'operator', mustChangePassword: true },
};

const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const optStr = (v, max) => v === undefined || isStr(v, 0, max);
const optPos = (v, int = false) => v === undefined || (typeof v === 'number' && v > 0 && (!int || Number.isInteger(v)));
const onlyKeys = (body, keys) => Object.keys(body).every((k) => keys.includes(k));

/** zTraderService's VerifyCredentialsDto (whitelist validation: unknown fields are a 400). */
export function verifyDtoProblem(body) {
    if (!body || typeof body !== 'object') return 'body required';
    if (!onlyKeys(body, ['username', 'password', 'clientIp', 'userAgent'])) return 'unknown field';
    if (!isStr(body.username, 1, 64)) return 'username must be 1-64 chars';
    if (!isStr(body.password, 1, 128)) return 'password must be 1-128 chars';
    if (!optStr(body.clientIp, 64)) return 'clientIp must be at most 64 chars';
    if (!optStr(body.userAgent, 300)) return 'userAgent must be at most 300 chars';
    return null;
}

const ORDER_FIELDS = [
    'uuid',
    'accountId',
    'symbol',
    'symbolId',
    'volume',
    'orderType',
    'side',
    'price',
    'stopLoss',
    'takeProfit',
    'relativeStopLoss',
    'relativeTakeProfit',
    'expirationTimestamp',
    'unitsPerLot',
    'mode',
    'comment',
];

/** zTraderService's CreateOrderDto, the parts the Actor can get wrong. */
export function orderDtoProblem(body) {
    if (!body || typeof body !== 'object') return 'body required';
    if (!onlyKeys(body, ORDER_FIELDS)) return 'unknown field';
    if (!isStr(body.uuid, 8, 100) || !/^[A-Za-z0-9_-]+$/.test(body.uuid)) return 'bad uuid';
    if (!optPos(body.accountId, true)) return 'accountId must be a positive integer';
    if (typeof body.symbol !== 'string' || !/^[A-Z0-9._]{3,20}$/.test(body.symbol)) return 'bad symbol';
    if (!(typeof body.volume === 'number' && body.volume > 0 && body.volume <= 100)) return 'bad volume';
    if (Math.round(body.volume * 100) !== body.volume * 100) return 'volume has more than 2 decimals';
    if (!['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'].includes(body.orderType)) return 'bad orderType';
    if (!['BUY', 'SELL'].includes(body.side)) return 'bad side';
    for (const k of ['price', 'stopLoss', 'takeProfit', 'unitsPerLot']) if (!optPos(body[k])) return `bad ${k}`;
    if (!optStr(body.mode, 40) || !optStr(body.comment, 100)) return 'mode/comment too long';
    return null;
}

/**
 * Minimal stand-in for zTraderService: `POST /api/v1/auth/verify` plus a few `/gold/*`
 * routes. Records every request so tests can assert what reached the "service".
 */
export async function startStubService() {
    const requests = [];
    /**
     * Per-user overrides for GET /api/v1/auth/users/:id, keyed by user id:
     *   { status: 404 | 503 | ... }        answer with that status
     *   { role, name, disabled, mustChangePassword, passwordChangedAt }  patch the record
     */
    const userOverrides = new Map();
    let usersEndpointDown = false; // true -> destroy the socket (service unreachable)

    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : undefined;
        const url = new URL(req.url, 'http://stub');
        requests.push({
            method: req.method,
            path: url.pathname,
            search: url.search,
            url: req.url,
            headers: req.headers,
            body,
        });

        const send = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(payload === undefined ? '' : JSON.stringify(payload));
        };

        if (req.headers['x-api-key'] !== STUB_API_KEY) return send(401, { statusCode: 401, message: 'bad api key' });

        const route = `${req.method} ${url.pathname}`;
        if (route === 'POST /api/v1/auth/verify') {
            const problem = verifyDtoProblem(body);
            if (problem) return send(400, { statusCode: 400, message: [problem], error: 'Bad Request' });
            const { username, password } = body;
            // the service answers 401 for a locked account (no enumeration); 429 only when rate limiting
            if (username === 'locked') return send(401, { statusCode: 401, message: 'Unauthorized' });
            if (username === 'ratelimited') {
                return send(429, {
                    statusCode: 429,
                    message: 'ThrottlerException: Too Many Requests',
                    retryAfterSec: 900,
                });
            }
            if (username === 'broken') return send(500, { message: 'boom' });
            const user = USERS[username];
            if (!user || password !== PASSWORD) return send(401, { statusCode: 401, message: 'Unauthorized' });
            return send(200, {
                user: {
                    disabled: false,
                    mustChangePassword: false,
                    lastLoginAt: null,
                    createdAt: '2026-01-01T00:00:00Z',
                    ...user,
                },
            });
        }
        const userMatch = req.method === 'GET' && url.pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)$/);
        if (userMatch) {
            if (usersEndpointDown) return req.socket.destroy();
            const id = decodeURIComponent(userMatch[1]);
            if (!/^u-[a-z]+$/.test(id)) return send(400, { statusCode: 400, message: 'invalid id' });
            const base = Object.values(USERS).find((u) => u.id === id);
            if (!base) return send(404, { statusCode: 404, message: 'Not Found' });
            const { status, passwordChangedAt = null, ...patch } = userOverrides.get(id) ?? {};
            if (status) return send(status, { statusCode: status, message: 'override' });
            const user = { disabled: false, mustChangePassword: false, ...base, ...patch };
            if (user.disabled) return send(404, { statusCode: 404, message: 'Not Found' });
            return send(200, { user, passwordChangedAt });
        }
        if (route === 'POST /orders') {
            const problem = orderDtoProblem(body);
            if (problem) return send(400, { statusCode: 400, message: [problem], error: 'Bad Request' });
            return send(201, { ok: true, uuid: body.uuid });
        }
        if (route === 'GET /gold/status') return send(200, { enabled: false, modes: [], accountMode: 'DEMO' });
        if (route === 'GET /gold/modes') return send(200, { modes: [{ mode: 'swing', rr_min: 2 }] });
        if (route === 'GET /gold/settings') return send(200, { risk_usd_per_trade: 50, overridden: [] });
        if (route === 'POST /gold/settings') return send(201, { applied: Object.keys(body ?? {}) });
        if (route === 'POST /gold/run') return send(201, { outcome: `no trade (${body?.mode})` });
        if (route === 'POST /gold/automate') return send(201, { enabled: body?.enabled });
        if (route === 'GET /gold/activity') return send(200, { latest_id: 0, entries: [] });
        if (route === 'GET /gold/archive') return send(200, []);
        if (req.method === 'GET' && url.pathname.startsWith('/gold/archive/')) return send(200, { file: url.pathname });
        send(404, { statusCode: 404, message: 'not found' });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        /** requests whose path starts with prefix */
        calls: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
        reset: () => requests.splice(0),
        /** Patch (or with `null`, restore) what GET /api/v1/auth/users/:id returns for a user id. */
        setUser: (id, override) => (override ? userOverrides.set(id, override) : userOverrides.delete(id)),
        setUsersEndpointDown: (down) => {
            usersEndpointDown = down;
        },
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    };
}
