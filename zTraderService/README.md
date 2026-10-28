# zTraderService

An automated trading service for gold (XAUUSD) and major FX pairs (EURUSD, GBPUSD, USDJPY) on the
[cTrader Open API](https://help.ctrader.com/open-api/). It ships with a multi-user web dashboard. The
service trades a **DEMO** account by default. LIVE needs two explicit switches (see [LIVE interlock](#live-interlock)).

- **TA engine.** A rule-based engine computes each decision in code. It runs per mode (scalp, intraday,
  swing, position) on cTrader trendbars, plus companion series from Yahoo Finance (DXY, US10Y, VIX, …) and RSS
  headlines. Each mode has its own playbook, minimum R:R, session windows and order TTL.
- **Optional AI, under rails.** Gemini can *assist* (confirm, adjust or veto a TA setup) or *lead* (propose a
  setup when TA finds none, at half size or less, through stricter checks). Claude is available as an
  alternative analysis engine (`GOLD_ENGINE=ai`). AI output only reaches the broker after code-side guards
  have passed. The guards cover side of the market, entry drift, SL/TP placement, R:R, minimum confidence and
  size. If Gemini has no key, fails, times out or hits its daily call budget, the round uses TA only.
  A Claude refusal or a truncated answer is treated as NO_TRADE.
- **Multi-instrument loop.** One scheduler per instrument and mode, aligned to bar closes. It is aware of
  market hours (gold and FX sessions, the daily maintenance break, weekends) and pauses and resumes on its own.
- **Risk limits.** Risk-based sizing (fixed USD per trade, converted per instrument's pip value), per-instrument
  lot caps, open-position caps per instrument and in total, a daily loss stop, a cooldown after a loss, a
  scalp-per-day cap, and a breakeven/trailing manager. Settings changed from the dashboard are persisted so
  that a restart can never silently fall back to looser `.env` values.
- **Archive and audit.** Every analysis round is written as JSON under `archive/<mode>/`. This archive feeds
  the replay regression suite. Every dashboard action and every auth event is written to an audit log in MongoDB.
- **Manual review flow.** `POST /gold/claude/analyze` parks the TA order. A human, or the `/gold-run` Claude
  Code skill in `.claude/skills/`, reviews it and then confirms or rejects it within 10 minutes.

## Architecture

```mermaid
flowchart LR
    B["Browser<br/>React dashboard (web/)"] -- "session cookie + X-CSRF-Token<br/>/api/auth · /api/users · /api/audit · /api/dashboard" --> API
    A["zTraderActor (optional)<br/>Express + socket.io"] -- "x-api-key<br/>/gold · /orders · /api/v1/klines<br/>/api/v1/auth/verify · socket.io /klines" --> API
    subgraph S["zTraderService (NestJS, one process)"]
        API["HTTP + socket.io<br/>guards: throttle → auth → CSRF → role"]
        G["gold: TA / AI / scheduler / risk"]
        X["ctrader: Open API socket"]
        API --> G --> X
    end
    X -- "protobuf over WSS :5035" --> C[("cTrader Open API<br/>DEMO / LIVE")]
    S -- "users · sessions · audit · orders" --> M[("MongoDB")]
    G -. "optional" .-> AI["Gemini / Claude"]
    G -. "companions, news" .-> Y["Yahoo Finance, RSS"]
    G -. "optional" .-> T["Telegram"]
```

The built dashboard (`web/dist`) is served by the same Nest process. The browser therefore talks to a single
origin, and the cookie and `Origin` checks work without CORS.

## Folder layout

```
src/
  main.ts, app.setup.ts   bootstrap; configureApp() is shared with the e2e tests
  app.module.ts           module graph and the global guard chain
  config/                 env validation (fails closed at boot)
  common/                 auth decorators and roles, helmet/CSP, SPA serving, constant-time compare
  auth/                   login, sessions (MongoDB), CSRF and role guards, scrypt hashing, /api/v1/auth for the Actor
  users/  audit/          user management and the audit log (admin)
  health/                 /health (liveness) and /health/ready (MongoDB ping)
  dashboard/              /api/dashboard/*, the browser-facing facade over the gold bot
  gold/                   the trading bot
    domain/               instrument profiles, mode playbooks, indicators, market hours
    data/                 dataset builder (cTrader + Yahoo + RSS), optional remote ZIP source
    analysis/             rule-based TA engine
    ai/                   Gemini assist/lead, Claude engine
    records/              archive, activity feed, trade history
    gold-automate.service.ts   scheduler, risk guards, sizing, order placement, position manager
  ctrader/                cTrader Open API client (protobuf over WebSocket, heartbeat, reconnect)
  orders/  execution/     POST /orders (idempotent by uuid), order history, placement on cTrader
  klines/                 live trendbar and indicator feed for zTraderActor (REST + socket.io), legacy strategy engine
  telegram/               notifications
  cli/                    create-user command
web/                      React 19 + Vite dashboard (TanStack Router / Query / Table, Vitest)
test/e2e/                 HTTP end-to-end suites (TypeScript, node:test)
test/*.test.js            trading-logic suites against the compiled dist/
proto/                    cTrader Open API .proto files
scripts/                  baseline builder for the regression suite, backtest export/run
docs/                     api.md (HTTP contract), deploy.md (deployment)
GOLD_BOT.md, RESEARCH.md  bot design notes and the research behind each mode (Thai)
```

## Security model

| Concern | Implementation |
|---|---|
| Browser auth | Sessions are stored in MongoDB. The cookie holds a random 256-bit token, and only its SHA-256 is stored. The cookie is `HttpOnly`, `SameSite=Strict`, and over HTTPS it is `__Host-` + `Secure`. A session ends 12 h after login or after 2 h idle. Logout, a password change or reset, a disable and a role change all revoke sessions server-side. |
| Passwords | scrypt (N=2^15, r=8, p=3) with a per-user salt. The parameters are stored in the hash, and old hashes are rehashed on the next login. Passwords are 12–128 characters and may not contain the username. A temporary password forces a change before anything else works. |
| Roles | `viewer` (read), `operator` (trading actions, settings), `admin` (users, audit). The last active admin cannot be demoted or disabled. |
| CSRF | A per-session synchroniser token is required in `X-CSRF-Token` on every write. Writes are also rejected when `Origin` does not match the host. |
| Brute force | Login is throttled per IP (`LOGIN_RATE_LIMIT_PER_MIN`). An account locks for 15 min after 5 failures. Unknown users get the same timing and the same `401`. A global per-IP budget covers every route. |
| Machine API | `x-api-key` (at least 32 characters, compared in constant time). It is accepted **only** on machine routes. A browser session cannot call them, and the key cannot call the dashboard API. The socket.io `/klines` handshake requires the key. |
| HTTP hardening | helmet with a strict CSP (`'self'` only, `frame-ancestors 'none'`, no inline script), HSTS, `no-referrer`, `Cache-Control: no-store` on API responses, a 100 kB JSON limit, and whitelist validation that rejects unknown body fields. `TRUST_PROXY` controls which `X-Forwarded-*` headers are believed. |
| Env validation | Boot fails with a list of problems when `MONGO_URI` or `API_KEY` is missing or weak, or when a value is out of range. Tests run with `NODE_ENV=test`, which ignores `.env`. |

### LIVE interlock

`CTRADER_ACCOUNT_MODE=LIVE` alone refuses to boot. Real money also requires `CTRADER_ALLOW_LIVE=true`.
The mode selects the cTrader endpoint (`demo.` or `live.ctraderapi.com`) and the account (`DEMO_ACCOUNT_ID`
or `LIVE_ACCOUNT_ID`). `POST /orders` refuses any `accountId` other than the one the service trades on.

The full HTTP contract is in [docs/api.md](docs/api.md).

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 24.11, TypeScript ~6.0 (strict) |
| API | NestJS 12.3 (Express), @nestjs/throttler 6.7, @nestjs/event-emitter, class-validator 0.15 |
| Realtime | socket.io 4.8 (`@nestjs/platform-socket.io`) |
| Broker | cTrader Open API over `ws` 8.22 + protobufjs 8.8 |
| Database | MongoDB via Mongoose 9.11 |
| Security | helmet 8.3, cookie-parser, Node `crypto` (scrypt, timingSafeEqual) |
| Market data / TA | yahoo-finance2 4.0, rss-parser 3.13, technicalindicators 3.1 |
| AI (optional) | @google/genai 2.31 (Gemini), @anthropic-ai/sdk 1.3 (Claude) |
| Dashboard | React 19.3, Vite 8.3, TanStack Router 1.170 / Query 5.105 / Table 9.3 |
| Tests | node:test + supertest 7.3 + mongodb-memory-server 11.3 (API), Vitest 5.0 + Testing Library (web) |
| Tooling | ESLint 10 + typescript-eslint 8.72, Prettier 3.9 |

## Local development

Prerequisites: Node.js 24.11 or later, and a MongoDB instance. You can use a local `mongod` or a throwaway
container (`docker run -d --name ztrader-mongo -p 27017:27017 mongo:8`). To run the whole stack in containers
instead (`docker compose --env-file .env.compose up -d --build`), see [docs/deploy.md](docs/deploy.md).

```sh
cd zTraderService
npm ci
npm --prefix web ci
cp .env.example .env      # set MONGO_URI, API_KEY (openssl rand -hex 32), cTrader credentials

npm run build             # API (dist/) + dashboard (web/dist/)
```

Create the first admin in one of two ways:

```sh
# a) CLI: prompts for the password without echo (or reads it from stdin)
npm run user:create -- --username admin --role admin --name "Admin"

# b) bootstrap env: set BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD for the first boot only.
#    The admin is created when the users collection is empty. Remove both afterwards.
```

Both ways force a password change at the first login. Then run the service:

```sh
npm start                 # http://localhost:6500  (API + built dashboard)
npm run start:dev         # API with watch mode
npm run dev:web           # Vite dev server for web/, proxies /api and /health to :6500
```

The bot does not trade until you start the loop from the dashboard or set `GOLD_AUTOMATE_ENABLED=true`.
Over plain HTTP the session cookie is named `zt_session` without `Secure`. Behind HTTPS it becomes
`__Host-zt_session`.

## Testing

```sh
npm test                  # build:api, then test:e2e + test:instruments + test:regression
npm run test:e2e          # HTTP end-to-end (needs no external services)
npm run test:instruments  # trading-logic suites against dist/
npm run test:regression   # replay against a baseline build (see below)
npm --prefix web test     # dashboard (Vitest)
npm run typecheck && npm run lint
```

| Suite | What it proves |
|---|---|
| `test/e2e/auth.e2e.test.mts` | Login and cookie flags, identical `401` for unknown users, body whitelisting, security headers, CSRF token and `Origin` checks, the role matrix, the forced password change, revocation on disable/reset, the last-admin rule, session listing and revocation, and the 2 h idle / 12 h absolute expiry (with an injected clock). |
| `test/e2e/bruteforce.e2e.test.mts` | Lockout after 5 failures even with the right password (and that it is audited), and the per-IP login throttle. |
| `test/e2e/machine.e2e.test.mts` | API-key routes refuse a bad or missing key. Session and key cannot stand in for each other. Actor endpoints `/api/v1/auth/verify` and `/users/:id`. Strict `POST /orders` validation, the account-id check, idempotency per `uuid` under concurrent requests. The socket.io `/klines` handshake. |
| `test/e2e/proxy.e2e.test.mts` | With `TRUST_PROXY=1` and HTTPS at the proxy, the cookie becomes `__Host-` + `Secure`. |
| `test/security.test.js` | scrypt and its policy, constant-time compare, a spoofed `X-Forwarded-Proto` has no effect, unsafe env refuses to boot, RSS prompt-injection handling, and no secrets or account ids in AI prompts. |
| `test/gold-ai-assist.test.js`, `test/ai-lead.test.js` | AI assist/lead guard rails: malformed or unsafe AI output is discarded, and AI can only shrink risk in assist mode. |
| `test/gemini-shape.test.js` | Offline Gemini request and response shape (no key, no network). |
| `test/instrument-fx.test.js`, `test/multi-instrument.test.js` | FX profiles (pip value, sizing, market hours, session guards, round numbers), per-instrument state isolation, the total position cap. |
| `test/instrument-regression.test.js` | The XAUUSD decisions of the current build are identical to a baseline build. It replays every archived round and hundreds of seeded synthetic series. |

The e2e suites boot the real `AppModule` from `dist/` with the same `configureApp()` as production, against
mongodb-memory-server (or `TEST_MONGO_URI`). cTrader points at a closed local port, and AI and Telegram keys
are blanked, so no test can reach a broker, a chat or a paid API.

The regression suite needs two local inputs. The first is `dist-baseline/`: `npm run baseline` builds it in a
temporary git worktree from the tag `savepoint-2026-10-28-pre-resume-deploy`, or you pass `BASELINE_DIST`.
The second is a populated `archive/`, which is not committed. On a fresh clone that has neither, run
`npm run test:e2e && npm run test:instruments`.

## Configuration

Every key is listed and commented in [.env.example](.env.example). The ones that matter first:

| Key | Default | Purpose |
|---|---|---|
| `MONGO_URI` | (required) | `mongodb://` or `mongodb+srv://` |
| `API_KEY` | (required, ≥ 32 chars) | machine API key, shared with zTraderActor |
| `NODE_ENV` | `development` | `production` / `test` |
| `PORT` | `6500` | HTTP port |
| `TRUST_PROXY` | `0` | proxy hops to trust (`1` behind Coolify/Traefik) |
| `SESSION_COOKIE_SECURE` | `auto` | `auto` follows the request scheme; `true` / `false` force it |
| `LOGIN_RATE_LIMIT_PER_MIN` | `10` | login attempts per IP per minute |
| `WEB_DIST_DIR` | `./web/dist` | built dashboard |
| `BOOTSTRAP_ADMIN_USERNAME` / `_PASSWORD` | unset | first-run admin, set both or neither |
| `APP_ID`, `APP_SECRET`, `ACCESS_TOKEN` | | cTrader Open API application and token |
| `CTRADER_ACCOUNT_MODE` | `DEMO` | `DEMO` / `LIVE` |
| `CTRADER_ALLOW_LIVE` | `false` | second switch for LIVE |
| `DEMO_ACCOUNT_ID` / `LIVE_ACCOUNT_ID` | | cTrader account ids |
| `CTRADER_HOST` | unset | endpoint override only (tests). Unset = derived from the mode |
| `GOLD_AUTOMATE_ENABLED` | `false` | start the loop at boot |
| `GOLD_INSTRUMENTS`, `GOLD_MODES`, `TRADE_INSTRUMENT` | | what to trade |
| `GOLD_RISK_USD_PER_TRADE`, `GOLD_DAILY_MAX_LOSS_USD`, `GOLD_MAX_OPEN_POSITIONS*`, `GOLD_MAX_LOT*` | | risk limits (also editable from the dashboard) |
| `GOLD_ENGINE`, `GOLD_AI_MODE`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GOLD_AI_MAX_CALLS_PER_DAY` | `ta`, `off` | AI engine, role and budget |
| `GOLD_ARCHIVE_DIR`, `GOLD_SETTINGS_FILE` | `./archive`, `./data/runtime-settings.json` | on-disk state; mount these in containers |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | notifications |

## Deployment and API

- Docker image, compose file, Coolify and the reverse proxy: [docs/deploy.md](docs/deploy.md)
- HTTP and socket.io contract, roles, error shape: [docs/api.md](docs/api.md)
- Day-to-day operation (Thai): [RUN.md](RUN.md)

## Known limitations

- **Single instance.** The loop scheduler, pending approvals, per-day counters, the breakeven manager and the
  cTrader socket are all in-process, so two replicas would double-trade. Run exactly one.
- **Runtime loop state is in memory.** A restart stops the loop (unless `GOLD_AUTOMATE_ENABLED=true`) and drops
  pending approvals. Risk settings changed from the dashboard survive in `GOLD_SETTINGS_FILE`, which is a
  local file, not MongoDB, so mount it as a volume.
- **Broker payloads are untyped at the protobuf boundary.** Decoded cTrader messages are `any`, which accounts
  for about 125 `@typescript-eslint/no-unsafe-argument` lint warnings. There are no lint errors.
- **zTraderActor sessions are separate.** The Actor verifies credentials against this service and polls
  `/api/v1/auth/users/:id` to pick up disables and role changes. Its own sessions live in its memory, though,
  so they are not listed in or revocable from this dashboard.
- Machine-API calls (`x-api-key`) are not attributed to a user in the audit log. Only dashboard actions are.
- The `klines` module still contains the legacy event-driven Sonic/Scalper engine used with zTraderActor. Do
  not run it on XAUUSD at the same time as the gold loop.
