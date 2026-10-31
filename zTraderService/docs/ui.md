# Dashboard UI — where it comes from and what is ours

The dashboard in `web/` is a trading terminal for the Z Trader bot. This page lists what was borrowed,
where from, and under which licence, and what was built for this project. Short answer: the **look and the
screen layout** follow OpenTerminalUI. **All code, and every backend and trading feature, was written for
Z Trader.**

## 1. Borrowed

### Layout and visual design: OpenTerminalUI (MIT)

[OpenTerminalUI](https://github.com/Hitheshkaranth/OpenTerminalUI) is an open-source, Bloomberg-style research
terminal (React + Tailwind, MIT licence). It was used as a **design reference only**. No source file was copied:
OpenTerminalUI is built on Tailwind, and this UI is built on MUI, so every component was written from scratch.
What we took:

| Taken from OpenTerminalUI | Where it shows up here |
|---|---|
| Shell layout: icon rail on the left; command bar, ticker tape and top bar (with breadcrumb) across the top; page in the middle; Context Rail on the right; status bar along the bottom | `src/shell/TerminalShell.tsx` and the other files in `src/shell/` |
| "GO bar" idea: type a function code or a symbol, Bloomberg style | `src/shell/CommandBar.tsx`, `src/shell/commands.ts` |
| Launchpad idea: a tile grid of panels you can drag and resize, with workspace presets | `src/workspace/` |
| Ops-dashboard pattern: a header, role tabs, then a grid of panels | `src/pages/BotPage.tsx` |
| Colour tokens of its "terminal-noir" (dark) and "light-desk" (light) themes, the compact density, and the uppercase panel titles. **The accent is blue here instead of OpenTerminalUI's orange.** | `src/theme/tokens.ts`, `src/theme/theme.ts` |

### Libraries

| Library | Version | Licence | Used for |
|---|---|---|---|
| MUI (`@mui/material`, `@mui/icons-material`) | 9.5 | MIT | every component, theming, dark/light schemes |
| MUI X Charts | 9.16 | MIT | cumulative P&L chart on the history view |
| TanStack Query / Router / Table / Form / Virtual | 5.105 / 1.170 / 9.3 / 1.33 / 3.14 | MIT | server state, routing, tables, forms, virtualized logs |
| TradingView Lightweight Charts | 5.2 | Apache-2.0 | candlestick chart (its attribution logo is kept on, as the licence asks) |
| react-grid-layout | 2.3 | MIT | the Launchpad grid |
| Emotion | 11 | MIT | MUI's style engine (CSP nonce aware) |
| IBM Plex Sans / Mono (via Fontsource) | 5.3 | SIL OFL 1.1 | fonts, served from our own origin |

## 2. Built for Z Trader

### Frontend (`web/src`)

Every screen and component is new code. The bot-specific parts don't exist in OpenTerminalUI in any form:

- **Live price chart** (`features/chart/`)
  - Pick the data source per instrument: the cTrader account broker, or one of several TradingView exchanges.
  - History comes over REST, live bars over Server-Sent Events.
  - Open positions (entry/SL/TP) and parked decisions are drawn as price lines.
- **Execution control** (`features/bot/`)
  - Start/stop the automated loop with a choice of instruments and modes; a LIVE account needs the word typed to confirm.
  - Manual Run / Analyze.
  - Per-mode cards with the AI verdict, and parked decisions you can fire or reject.
- **Risk profiles** (`features/risk/`)
  - Built-in and saved profiles. A % value is shown as the USD amount for the live balance.
  - Apply shows a before → after table.
  - Risk-limit form with server-side ranges (TanStack Form), plus the daily-stop meter and kill switch.
- **AI decision settings** (`features/ai/`)
  - Decision mode: TA only / TA → AI confirm / TA + AI lead / AI only.
  - Model picker (Gemini, Claude), "intelligence" (thinking depth), strictness, when to ask the AI, daily quota.
- **Strategy page** (`features/strategy/`): controls and logs for the legacy Sonic/Scalper loop running in zTraderActor.
- **Admin, account and records:**
  - users, audit trail and sessions
  - archive of analysis rounds, trade history, news
- **Plumbing:**
  - promise-based themed dialogs and toasts (`components/dialogs/`)
  - a role-aware GO bar and command palette
  - per-browser terminal preferences (`shell/terminalStore.ts`)
  - CSP-safe styling: Emotion reads the per-request nonce the server writes into `index.html`

### Backend and trading logic (`src/`), all written for Z Trader

Nothing on the server side comes from OpenTerminalUI. Below is how the main parts work.

**Analysis and decisions** (`src/gold/`)
- A rule-based TA engine runs a playbook per mode (scalp / intraday / swing / position) for XAUUSD, EURUSD,
  GBPUSD and USDJPY.
- An optional AI layer sits on top of TA:
  - *assist*: the AI may confirm, adjust or veto a TA setup, and can only lower risk.
  - *lead*: when TA finds nothing, the AI may propose a trade at half size or less.
  - *ai_only*: the AI proposes every trade.
- AI answers always pass the same code guards: R:R minimum, ATR-bounded stop, correct side of the market,
  size cap, minimum confidence, risk budget.
- **Strictness** (`src/gold/ai/ai-strictness.ts`) only ever tightens: above "normal", AI confidence below 6/7/8
  vetoes the trade, the prompt gets stricter and the sampling temperature is capped.

**Risk**
- Guards: risk per trade, a daily loss stop (with a manual reset), open-position caps per instrument and in
  total, a cooldown after a losing close, and per-instrument lot caps.
- Settings are validated all-or-nothing and persisted to a file, so a restart never falls back to looser values.
- **Risk profiles** (`src/risk-profiles/`) resolve % amounts against the live balance and go through that same
  validated path. Every apply is audited, and later manual edits mark the profile "modified".

**Broker access** (`src/ctrader/`)
- cTrader Open API over protobuf/WebSocket.
- Historical requests (deal lists, trendbars) share a limiter that keeps them under cTrader's per-second cap,
  and are retried with exponential backoff and jitter (`history-limiter.ts`).
- The daily-stop and cooldown guards read one cached, single-flight deal list (`src/gold/records/deal-cache.service.ts`).
  It is refreshed on every execution. If it cannot be read, both guards skip the round rather than trade blind.

**Chart data** (`src/chart/`, `src/integrations/tradingview/`)
- Session-authenticated REST and SSE endpoints.
- The TradingView client is our own Node implementation of the websocket protocol, the same protocol our
  z-service project reads through the open-source tvDatafeed library. It includes framing, a request throttle
  and optional sign-in.
- cTrader bars come from trendbars; the forming bar is built from spot prices.
- Upstream subscriptions are shared between viewers and closed when nobody is watching.

**Security and accounts** (`src/auth`, `src/users`, `src/audit`)
- Session cookies with CSRF protection and four roles (viewer / operator / admin / demo). Demo is simulated
  end to end: no order, no AI call, nothing saved. The UI shows a banner and a "simulated" toast.
- Forced password change, an audit log of every action, a strict CSP with a per-request style nonce.
- The machine API key is never accepted from a browser.

**Actor bridge** (`src/actor-bridge/` + `zTraderActor/src/http/routes/machine.js`)
- The dashboard controls the legacy strategy loop through API-key machine routes on the Actor.
- Every call is proxied on behalf of the signed-in user and audited.

## 3. Secrets

The repository holds no credentials. Every key (cTrader app/token, AI keys, TradingView token, API key) is read
from environment variables. See `.env.example`; `.env` files are git-ignored.
