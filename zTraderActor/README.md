# zTraderActor

zTraderActor is a small Node.js service with two jobs:

1. **Operator dashboard for the gold bot.** It serves `public/` and proxies `/api/gold/*` to
   zTraderService's machine API. The `x-api-key` is added on the server, so the browser never sees it.
2. **Legacy Sonic/Scalper strategy loop.** The `StrategyController` polling loop, started and stopped
   over socket.io. It reads market data from zTraderService (`/api/v1/klines`, socket.io `/klines`) and
   sends orders to `POST /orders`.
3. **Machine API for the service dashboard.** `GET /api/machine/engine`, `POST /api/machine/engine/start` and
   `/stop`, and `GET /api/machine/logs` (ring buffer of the trade feed) require the shared `x-api-key`. The
   zTraderService Strategy page uses them through its `/api/actor/*` bridge (`ACTOR_URL` on the service).

Users, passwords, lockout and the audit log all live in zTraderService. This app checks credentials
against the service and keeps its own short-lived sessions.

## Layout

```
src/
  server.js              entry point: config, wiring, listen, graceful shutdown
  actor.js               composition root (HTTP + socket.io + sessions), used by server.js and tests
  config/env.js          reads and validates the environment once at boot
  auth/                  SessionStore, cookies, CredentialVerifier (service verify call), roles, middleware
  http/                  Express app, routes (auth, gold proxy, machine API), input validation
  realtime/socket.js     socket.io: handshake auth, trading commands, log/market broadcast
  logging/               logger.js: system log (stdout) and trade feed (stdout + dashboards);
                         LogBuffer.js: last 500 trade-feed lines for the machine API; channels.js: order/system split
  services/              ServiceClient (fetch), Klines/News/Indicator services, TradeDispatcher,
                         MarketFeed (socket.io client), TradingEngine (the polling loop)
  strategies/            StrategyController and the list of strategy modes
public/                  index.html, app.js, styles.css (no inline scripts or styles)
test/                    node:test suites with a stub zTraderService
```

## Configuration

Configuration is read from the environment. `npm start` and `npm run dev` also load a local `.env` if there
is one (`node --env-file-if-exists`). Copy `.env.example` to get started. Never commit `.env`. The app exits
at boot with a list of problems if a value is missing or invalid.

| Variable           | Required | Default  | Meaning                                                                                             |
| ------------------ | -------- | -------- | --------------------------------------------------------------------------------------------------- |
| `API_TRADER_URL`   | yes      |          | Base URL of zTraderService, e.g. `http://ztrader-service:6500`                                      |
| `API_KEY`          | yes      |          | Machine API key shared with zTraderService, at least 32 characters                                  |
| `PORT`             |          | `3000`   | HTTP port                                                                                           |
| `TRUST_PROXY`      |          | `0`      | Number of reverse-proxy hops. Set it to `1` behind Coolify/Traefik (client IP, HTTPS detection)     |
| `LOG_LEVEL`        |          | `info`   | `silent`, `error`, `warn`, `info` or `debug` (system log only)                                      |
| `SYMBOL`           |          | `XAUUSD` | Comma-separated symbols for the legacy loop                                                         |
| `STRATEGY_MODE`    |          | `Sonic`  | Initial mode shown for the loop: `Hardcode`, `Conservative`, `Swing`, `Merge`, `Sonic` or `Scalper` |
| `MAX_POSITIONS`    |          | `1`      | Max positions per symbol passed to the service                                                      |
| `TRADE_LOT_SIZE`   |          |          | Fixed lot size. If empty, the lot size is derived from `TRADE_AMOUNT_USD`                           |
| `TRADE_AMOUNT_USD` |          | `10`     | Risk amount used to derive the lot size                                                             |

zTraderService decides which cTrader account (demo or live) trades, so orders from the loop carry no
account id. cTrader tokens, MongoDB, Telegram and app secrets belong to zTraderService. This app does not read them, so
don't configure them here.

## Auth model

- **Login:** `POST /login {username, password}`. The app calls zTraderService
  `POST /api/v1/auth/verify` (with `x-api-key`), sending `{username, password, clientIp, userAgent}` within
  the service's DTO limits:
    - username at most 64 characters and password at most 128 (longer ones are a `400` here);
    - `clientIp` cut to 64 characters and `userAgent` cut to 300.
- **Verify answers:**
    - `401` is a bad password, or an unknown, disabled or locked account. The service doesn't distinguish
      them, and neither does the Actor.
    - `429` means the service is rate limiting. It is passed through as "too many attempts, try again later",
      with `retryAfterSec` and `Retry-After`.
    - Any other status is treated as a service error (`502`).
    - Users with `mustChangePassword` are refused and told to change the password on the main dashboard
      first.
- **Audit:** proxied writes (gold run, automate, settings) send `X-Actor-User: <session username>`, so
  zTraderService can record who acted. Orders placed by the strategy loop send `X-Actor-User: actor-loop`.
- **Sessions:** a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie. Over HTTPS the cookie is
  `__Host-zta_session` with `Secure`. Over plain HTTP (local dev) it is `zta_session`. Only the SHA-256 of
  the token is kept, in an in-memory map. A session ends 12 h after login, or after 2 h without a request,
  whichever comes first. Logout revokes it, and a sweep runs every minute. **Sessions are in memory: run a
  single instance, and expect everyone to be logged out after a restart or redeploy.**
- **CSRF:** `GET /me` and login return a per-session `csrfToken`. Every non-GET request except login must send
  it as `X-CSRF-Token`. Writes are also rejected when `Origin` doesn't match the host, or when
  `Sec-Fetch-Site` is cross-site.
- **Re-check against the service:** each live session is re-checked with zTraderService
  `GET /api/v1/auth/users/:id` at most once every 60 s. The check runs lazily on the next HTTP request,
  socket handshake or socket event, and a sweep every 60 s covers idle sessions. Only one check per session
  runs at a time.
    - `404` (the user is unknown or disabled), or `mustChangePassword` → the session is revoked and its
      sockets are disconnected.
    - `passwordChangedAt` later than the session's creation → revoked.
    - Role or name changed → the session is updated in place, so a demotion or promotion takes effect
      within 60 s. The dashboard picks it up through `/me`.
    - **The service is unreachable, or answers anything else → fail closed for writes, open for reads.**
      The session stays, and viewer-level reads keep working. Operator actions (gold run, automate,
      settings, `startTrading`/`stopTrading`) answer `503` until a later re-check succeeds. Reasoning: a
      service outage shouldn't log everyone out or blank the dashboard while trading may be in flight.
      But an account that might have been disabled or demoted in the meantime must not be able to place or
      change trades on stale data.
- **Roles** (from the service): `viewer` can only read. `operator` and `admin` can also start or stop
  trading and use the gold run, automate and settings actions.
- **socket.io:** the handshake must carry a valid session cookie and a same-origin `Origin`. Otherwise the
  socket is rejected. `startTrading` and `stopTrading` need operator or higher, and their payloads are
  validated (symbols `^[A-Z0-9]{3,16}$`, at most 10; mode must be a known strategy mode). The session is
  checked again on every event. Logs, market ticks and state go only to the `authenticated` room, and a
  session's sockets are disconnected when it ends.
- **Brute force:** `POST /login` allows 10 failed attempts per IP per 15 minutes. The service also locks the
  account itself.
- **Hardening:** helmet with a strict CSP (`script-src 'self'`, `style-src 'self'`, `frame-ancestors 'none'`),
  `Cache-Control: no-store` on dynamic routes, a 32 kB JSON body limit, validated proxy parameters (archive
  `mode`/`file` are pattern-checked, so path traversal is rejected), and generic upstream error messages.
  `GET /health` needs no auth and returns `{ "status": "ok" }`.

## Run

Requires Node.js 24 or later.

```sh
npm ci
cp .env.example .env      # then fill in API_TRADER_URL and API_KEY
npm run dev               # node --watch
npm start
```

| Script           | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `npm start`      | Run the server                                   |
| `npm run dev`    | Run with `node --watch`                          |
| `npm run lint`   | ESLint (flat config), then a Prettier check      |
| `npm run format` | Prettier write                                   |
| `npm test`       | `node:test` suites against a stub zTraderService |

The tests start the app in-process on an ephemeral port, together with a stub zTraderService. They use an
injected clock and a stub trading engine, so they never start the real strategy loop or call a real API.

## Deploy

See [COOLIFY_DEPLOY.md](COOLIFY_DEPLOY.md). The Docker image is `node:24-alpine` and multi-stage. It installs
with `npm ci --omit=dev --ignore-scripts`, runs as `USER node`, and has a `HEALTHCHECK` on `/health`.

## Known issues (pre-existing, deliberately not changed)

The refactor moved the trading code and swapped libraries without changing what it does. These issues are
left for the strategy owner to decide on:

- **`Hardcode` mode never trades.** `runHardcodeFlow` uses a `cross` variable that is never computed, so
  each tick throws a `ReferenceError` after fetching klines. The loop catches and logs it. The likely fix is
  `const cross = this.indicatorService.checkEMACross(ema8, ema21)`, but that would make the mode start placing
  STOP orders. The lint rules are disabled for that one function, with a comment.
- `calculateLotSize` fetches the account balance but never uses it.

Auth limits that follow from the design (not bugs):

- **Changes on the main dashboard reach the Actor within 60 s, not instantly.** A disable, demotion or
  password reset is picked up at the next re-check. Until then, the old role applies for at most 60 s.
- **Clock skew.** The `passwordChangedAt` check compares the service's timestamp with the Actor's session
  creation time. If the Actor's clock runs behind the service's, a login made seconds after a password
  change could be revoked at its first re-check (the user just logs in again). Keep both hosts on NTP.
- **Single instance only.** Sessions live in memory; see "Sessions" above.
