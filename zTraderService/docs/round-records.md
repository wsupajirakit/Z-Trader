# Round and trade records (for backtests)

Every analysis round stores the full configuration it ran under, so any trade can be traced back to its exact
settings. Rounds and trades can then be grouped by configuration and replayed. Both records below hold the same
**round context** (`src/gold/records/round-context.ts`, schema version `1`).

## Where the records are

| Record | Location | Written | Contains |
|---|---|---|---|
| Archive round | `GOLD_ARCHIVE_DIR/<mode>/<yyyymmdd_hhmmss>_<mode>.json` (dashboard: Archive) | every round, whatever the outcome | `context`, `decision`, `outcome`, `series_meta`, `series_tail` (the last `GOLD_ARCHIVE_BARS` bars of every series) |
| Order | MongoDB `orders` | every order the bot places | `configHash`, `riskProfile`, `context` (the round context + the market at send time), `archiveFile` (link to the round) |
| Closed trade | `GET /api/dashboard/history` | read from cTrader, joined to the order by position id | `risk_profile`, `config_hash`, `archive_file` |

## Round context

```jsonc
{
  "schema": 1,
  "config_hash": "3f9a0c1b2d4e",   // same settings → same hash (see below)
  "config": {
    "app": { "version": "1.0.0", "commit": null },        // commit = APP_COMMIT env at build time
    "account_mode": "DEMO",
    "instrument": { "key": "XAUUSD", "symbol_id": 41, "digits": 2, "pip": 0.1, "units_per_lot": 100 },
    "mode": { "name": "swing", "rr_min": 1.8, "period_min": 60, "tradable_modes": ["swing"] },
    "engine": "ta",                 // ta | ai (Claude decides alone)
    "data_source": "local",
    "risk_profile": { "id": "builtin:conservative", "name": "Conservative", "modified": false, "changed": [] },
    "risk": {
      "sizing": "risk", "risk_usd_per_trade": 117.62, "base_lot": 0.1, "daily_max_loss_usd": 470.5,
      "max_open_positions": 2, "max_open_positions_total": 3, "min_confidence": 8, "loss_cooldown_bars": 6,
      "scalp_max_per_day": 4, "max_lot": 0.1, "risk_tolerance": 1.2
    },
    "ai": {
      "mode_selected": "lead", "mode_effective": "lead", "provider": "gemini", "model": "gemini-3.5-flash",
      "thinking": "low", "strictness": "normal", "strictness_min_confidence": null, "gate": "near_miss",
      "temperature": 0.2, "max_calls_per_day": 10
    },
    "overrides": { "GOLD_RISK_USD_PER_TRADE": "117.62", "...": "..." }   // dashboard-set values; never credentials
  },
  "guards": {                       // what each guard saw; missing = the round stopped before that guard
    "open_positions": 0, "open_positions_total": 1, "daily_pnl_usd": -12.5,
    "last_loss_close_utc": null, "size_cap": null, "ai_mode_this_round": "lead"
  },
  "base_decision": { /* the TA (or Claude engine) decision before any AI layer changed it */ },
  "ai_answer":     { /* the AI's raw answer (assist verdict or proposal), when it was asked */ },
  "market": { "bid": 3980.41, "ask": 3980.49, "spread": 0.08, "tick_age_ms": 412 },
  "sizing": {                       // orders only: how the lot size was computed
    "method": "risk", "size": "full", "size_cap": null, "effective_size": "full", "sl_distance": 6.2,
    "risk_usd": 117.62, "usd_per_unit_per_lot": 100, "raw_lots": 0.1897, "max_lot": 0.1, "lots": 0.1
  }
}
```

- `ai_mode_this_round` can differ from `ai.mode_effective`. When the daily AI quota is used up, a lead/assist
  round runs as TA only, and an AI-only round places no trade.
- `risk_profile.modified` / `changed` show which settings were edited by hand after the profile was applied.

## `config_hash`

The first 12 hex characters of a SHA-256 over the `config` object, serialized as JSON with sorted keys. Two fields
are left out because they don't change how the bot decides: `app`, and the `modified` / `changed` bookkeeping of
the risk profile (only its `id` is hashed). Any change to risk limits, AI mode / model / thinking / strictness / gate,
engine, data source, instrument or mode gives a new hash.

## Using the records in a backtest

1. **Group results by configuration.** Group closed trades (`/api/dashboard/history`) by `config_hash` to compare
   win rate and net P&L per settings set. `risk_profile` gives the readable name.
2. **Replay a round.** The archive file holds the bars the round saw (`series_tail`) and the configuration
   (`context.config`). Feed both to the TA engine to get the same `base_decision`. Then apply `ai_answer` and the
   guards to check whether the final decision matches.
3. **What-if runs.** Change a value in `context.config.risk` or `context.config.ai`, replay the archived rounds,
   and compare against the hash group that actually traded.
4. **Sizing checks.** `context.sizing` holds every input of the lot calculation, so a backtest can recompute
   risk per trade exactly, including when the lot cap kicked in (`raw_lots` > `max_lot`).

Archive files written before schema 1 have no `context`. Orders placed before it have no `configHash` and show
`risk_profile: null` in the history.
