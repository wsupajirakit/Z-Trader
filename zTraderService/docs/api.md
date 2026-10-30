# zTraderService — HTTP API

Two audiences, two auth schemes. They never mix.

| Audience | Prefix | Auth |
|---|---|---|
| Browser dashboard (`web/`) | `/api/auth`, `/api/users`, `/api/audit`, `/api/dashboard` | session cookie + `X-CSRF-Token` on writes |
| Machines (zTraderActor, review scripts, curl) | `/gold`, `/orders`, `/history`, `/api/v1/klines`, `/api/v1/auth/verify`, socket.io `/klines` | `x-api-key: $API_KEY` |
| Probes | `/health` | none |

Errors use the NestJS shape: `{ "statusCode": 400, "message": "…" | ["…"], "error": "Bad Request" }`.
Request bodies are validated with a whitelist, so unknown fields are rejected with `400`.

---

## Browser session

- `POST /api/auth/login` sets an `HttpOnly`, `SameSite=Strict` cookie. Over HTTPS it is named
  `__Host-zt_session` and is `Secure`. Over plain HTTP (local dev) it is named `zt_session`. The server
  reads only the name it would issue for that request: over HTTPS a plain `zt_session` cookie is ignored.
  A cookie value that is not a token (for example cookie-parser's `j:{…}` JSON form) counts as no cookie.
  Login revokes the session cookie the browser already had before it creates the new session.
- HTTPS is decided by `req.secure`, so behind a TLS-terminating proxy set `TRUST_PROXY` (Coolify/Traefik
  = 1) or `SESSION_COOKIE_SECURE=true`. With `NODE_ENV=production`, `SESSION_COOKIE_SECURE=auto` and
  `TRUST_PROXY=0`, the app logs a loud warning at boot, because the cookies it issues then have no
  `Secure` flag.
- Sessions live in MongoDB (`sessions`). The cookie holds a random 256-bit token, and the database stores
  only its SHA-256, so a leaked database cannot be replayed as cookies.
- A session ends at whichever comes first: **12 h** after login (absolute) or **2 h** without a request (idle).
  Logout, a password change, a password reset, disabling the user or a role change all revoke sessions
  server-side, and that takes effect on the next request.
- **CSRF:** every `POST` / `PATCH` / `PUT` / `DELETE` under `/api/*` (except `login`) must send
  `X-CSRF-Token: <csrfToken>`. The token comes from `login` or `GET /api/auth/me` and stays fixed for the
  life of the session. Writes whose `Origin` does not match the host are rejected.
- **Brute force:** login is throttled per client IP (`LOGIN_RATE_LIMIT_PER_MIN`, default 10/min). Over
  the limit the answer is `429` from the throttler, with a `Retry-After` header. With `TRUST_PROXY=n` the
  client IP is the n-th `X-Forwarded-For` hop from the right (the hop our proxy wrote), so a client cannot
  rotate it by adding hops of its own. With `TRUST_PROXY=0`, `X-Forwarded-For` is ignored.
  After **5** failed passwords (counted atomically, so parallel attempts all count) an account is locked
  for **15 min**. While it is locked, every login is refused, the right password included, with the same
  `401` and the same body as a wrong password, after the same scrypt work. Unknown usernames and
  disabled users get that same `401` too. So the response reveals neither which accounts exist nor which
  are locked. The audit log records the real reason (`auth.login_failed` with `detail.reason`, or
  `auth.login_locked`).

### Roles

| Role | Can |
|---|---|
| `viewer` | read every dashboard endpoint |
| `operator` | viewer, plus every trading action and settings write |
| `admin` | operator, plus user management and the audit log |

### Types

```ts
type Role = 'admin' | 'operator' | 'viewer';

interface User {
  id: string;
  username: string;         // 3–32 chars, [a-z0-9._-], stored lower-cased; this is the login identifier
  name: string;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;   // true after create/reset — the UI must force the change-password screen
  lastLoginAt: string | null;    // ISO
  createdAt: string;             // ISO
}

interface SessionInfo {
  id: string; createdAt: string; lastSeenAt: string; expiresAt: string;
  ip: string; userAgent: string; current: boolean;
}

interface AuditEvent {
  id: string; at: string;
  actor: { id: string; username: string } | null;
  action: string;           // e.g. auth.login, auth.login_failed, user.create, trade.confirm, settings.update
  target: string | null;
  ip: string;
  success: boolean;
  detail: Record<string, unknown> | null;
}
```

Password rule: 9–128 characters and must not contain the username.

### `/api/auth`

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` | `200 { user, csrfToken }` · `401` (bad credentials, disabled or locked) · `429` (per-IP throttle) |
| POST | `/api/auth/logout` | — | `204` |
| GET | `/api/auth/me` | — | `200 { user, csrfToken }` · `401` |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` | `204` (signs out every other session) |
| GET | `/api/auth/sessions` | — | `200 SessionInfo[]` (own sessions only) |
| DELETE | `/api/auth/sessions/:id` | — | `204` |
| POST | `/api/auth/sessions/revoke-others` | — | `204` |

While `mustChangePassword` is true, every endpoint except `me`, `logout` and `change-password` returns
`403 { message: 'PASSWORD_CHANGE_REQUIRED' }`.

### `/api/users` (admin)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/users` | — | `200 User[]` |
| POST | `/api/users` | `{ username, name, role, password }` | `201 User` (`mustChangePassword: true`) · `409` username taken |
| PATCH | `/api/users/:id` | `{ name?, role?, disabled? }` | `200 User` |
| POST | `/api/users/:id/reset-password` | `{ password }` | `204` (sets `mustChangePassword`, revokes sessions) |

An admin cannot disable or demote themselves, and the last active admin can never be removed (`400`).
That holds when two admins demote or disable each other at the same moment: one of the two requests
gets the `400` (in a rare interleaving both do), and at least one active admin always remains. If the
user is changed by another request between the check and the write, the answer is `409`; reload and
try again.

### `/api/audit` (admin)

`GET /api/audit?limit=50&before=<cursor>` returns `200 { items: AuditEvent[], nextBefore: string | null }`,
newest first. `limit` is capped at 200. To get the next page, pass `nextBefore` back as `before` unchanged.
Treat it as opaque. It is currently `<ISO at>_<event id>`, so events that share a millisecond are neither
skipped nor repeated across pages. A plain ISO date is still accepted as `before` and returns the
events strictly older than it. Any other value is a `400`.

### `/api/dashboard` — what the dashboard UI calls

These are the same handlers that used to live under `/ui/api/*`. Only the prefix and the auth changed.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/dashboard/status` | viewer | full bot status |
| GET | `/api/dashboard/modes` | viewer | |
| GET | `/api/dashboard/instruments` | viewer | `{ active, list }` |
| GET | `/api/dashboard/activity?after=<id>` | viewer | `{ latest_id, entries }` |
| GET | `/api/dashboard/settings` | viewer | |
| GET | `/api/dashboard/news?limit=` | viewer | 1–50 |
| GET | `/api/dashboard/archive?mode=&limit=` | viewer | ≤ 200 |
| GET | `/api/dashboard/archive/:mode/:file?full=1` | viewer | |
| GET | `/api/dashboard/positions` | viewer | |
| GET | `/api/dashboard/history?days=` | viewer | 1–365 |
| GET | `/api/dashboard/ai/models` | viewer | Gemini + Claude models with the AI modes each can serve |
| GET | `/api/dashboard/account` | viewer | `{ available, accountId, mode, balance, currency, leverage }` |
| POST | `/api/dashboard/instrument` | operator | `{ symbol }` |
| POST | `/api/dashboard/settings` | operator | partial settings (risk limits, `ai_mode` off/assist/lead/ai_only, `ai_model`, `ai_thinking`, `ai_strictness` normal/strict/very_strict/maximum, `ai_gate`) |
| POST | `/api/dashboard/daily-stop/reset` | operator | |
| POST | `/api/dashboard/ai/reset-calls` | operator | |
| POST | `/api/dashboard/automate` | operator | `{ enabled, modes?, instruments? }` |
| POST | `/api/dashboard/run` | operator | `{ mode, force? }` |
| POST | `/api/dashboard/analyze` | operator | `{ mode, force? }` |
| POST | `/api/dashboard/confirm` | operator | `{ mode, id }` |
| POST | `/api/dashboard/reject` | operator | `{ mode, id, reason? }` |

Every operator action is written to the audit log.

`ai_strictness` only tightens: above `normal` an AI confidence below 6/7/8 vetoes the trade, the prompt asks for
stricter setups and Gemini's temperature is capped. Claude models (`claude-*`) serve the `ai_only` mode only.

### `/api/risk-profiles`

Built-in profiles (`builtin:conservative`, `builtin:balanced`, `builtin:aggressive`, `builtin:micro`) plus profiles
saved in MongoDB. Risk per trade and the daily stop can be USD or a % of the account balance. Applying a profile goes
through the same all-or-nothing settings path as `POST /api/dashboard/settings` and is persisted with the other
overrides; `GET /api/dashboard/settings` then reports `risk_profile: { id, name, modified, changed }`.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/risk-profiles` | viewer | `{ balance, active, profiles: [{ id, name, builtIn, values, resolved }] }` |
| POST | `/api/risk-profiles` | operator | `{ name, description?, values }` |
| PATCH | `/api/risk-profiles/:id` | operator | saved profiles only |
| DELETE | `/api/risk-profiles/:id` | admin | saved profiles only |
| POST | `/api/risk-profiles/:id/apply` | operator | resolves % against the live balance |

### `/api/chart` — candles for the terminal chart

Sources: `ctrader` (the account broker) and `tv:<EXCHANGE>` (TradingView). XAUUSD: OANDA, PEPPERSTONE, CAPITALCOM,
VANTAGE, ICMARKETS, EIGHTCAP, FOREXCOM, BLACKBULL. FX pairs: OANDA, FX_IDC, FOREXCOM, PEPPERSTONE, ICMARKETS,
CAPITALCOM, SAXO. The chart source never changes what the bot analyses (always the cTrader feed).
Optional env: `TV_AUTH_TOKEN` or `TV_USERNAME` / `TV_PASSWORD` (anonymous access is rate-limited harder).

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/chart/sources?symbol=` | viewer | `{ symbol, sources: [{ id, label, kind }] }` |
| GET | `/api/chart/bars?symbol&source&tf&limit` | viewer | tf M1…D1, limit 50–2000; `{ bars: [{ time, open, high, low, close, volume }] }` |
| GET | `/api/chart/stream?symbol&source&tf` | viewer | Server-Sent Events: `bar`, `status` (`live`/`reconnecting`/`error`) |

### `/api/actor` — the legacy strategy loop (zTraderActor)

Needs `ACTOR_URL`; the service calls the Actor's API-key machine routes on behalf of the signed-in user.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/actor/state` | viewer | `{ available, isRunning, symbols, mode, modes, symbolsLive }` or `{ available: false, reason }` |
| GET | `/api/actor/logs?after&limit` | viewer | `{ latestId, entries }` |
| POST | `/api/actor/start` | operator | `{ symbols, mode }`, audited |
| POST | `/api/actor/stop` | operator | audited |

---

## Machine API (`x-api-key`)

The paths are unchanged, because zTraderActor and external scripts call them. `API_KEY` is trimmed of
surrounding whitespace and must then be at least 32 characters. The key is compared in constant time.

- `/gold/*`, `POST /orders`, `GET /history`, `GET /history/stat`, `/api/v1/klines/*`
- Every machine write (`POST /gold/settings`, `/gold/run`, `/gold/automate`, `/gold/instrument`,
  `/gold/daily-stop/reset`, `/gold/ai/reset-calls`, `/gold/claude/*`, `POST /orders`) is written to the
  audit log, success or failure (validation failures included), with `actor: null` and
  `detail.via = 'api-key'`. zTraderActor sends `X-Actor-User: <username>` on the writes it proxies for
  a signed-in user; it is recorded as `detail.actorUser`, reduced to lower-case `[a-z0-9._-]` and at
  most 64 characters. The header is informational: the API key is what authenticates. Bodies over 4 KB
  are recorded by size only.
- `/gold/*` bodies use the same DTOs as `/api/dashboard/*`: `{ mode?, force?, symbol? }` for `run` and
  `claude/analyze`, `{ enabled, modes?, instruments? }` for `automate`, `{ symbol }` for `instrument`,
  `{ mode?, id }` for `claude/confirm`, `{ mode?, id, reason? }` for `claude/reject`. Unknown fields,
  modes or instruments are a `400` (they used to be dropped silently in `automate`). Settings are
  all-or-nothing: one invalid field is a `400` and nothing is applied.
- Errors: a rule the caller broke is a `400` with its message; a missing archive file is a `404`; any
  other failure is a `500` with a generic message (details stay in the service log).
- `POST /orders` takes no `unitsPerLot` (the lot size follows the symbol); `accountId: null` is the same
  as leaving it out. `GET /history?page=` is clamped to 1 or more.
- socket.io namespace `/klines`: the handshake must carry the `x-api-key` header (or `auth.apiKey`).
- `POST /api/v1/auth/verify` `{ username, password, clientIp?, userAgent? }` returns `200 { user }`, `401`
  or `429`. It applies the same lockout and audit rules as browser login (audit actions
  `auth.verify_actor*`). zTraderActor uses it so that users live in one place. A disabled or locked user
  is a `401` with the same body as a bad password. There is no lockout `429` and no `retryAfterSec`.
  `429` comes only from the throttle: `LOGIN_RATE_LIMIT_PER_MIN` per **`clientIp`** (the end user's
  address, which the Actor must send), so the Actor's users do not share one budget. Without
  `clientIp` the budget is per calling host. Usernames are matched case-insensitively. Any status
  other than 200, 401 or 429 counts as a service error.
- `GET /api/v1/auth/users/:id` returns `200 { user, passwordChangedAt }`, or `404` when the user is
  unknown or disabled. zTraderActor polls it for its live sessions, so that a disable, a role change
  or a password reset made on the dashboard also ends or downgrades sessions held by the Actor.

## Probes

- `GET /health` (liveness) returns `200 { status: 'ok' }`.
- `GET /health/ready` (readiness: MongoDB ping) returns `200 { status: 'ok' }` or `503 { status: 'unavailable' }`.

Both need no auth and reveal nothing else.
