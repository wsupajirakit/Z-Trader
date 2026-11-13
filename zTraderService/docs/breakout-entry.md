# Entering with the break (scalp #2 / intraday #2)

Since 10 November 2026 the Asian-range break setups enter **with** the break — a STOP just past the
bar that closed outside the range (sent at market if price is already through it) — instead of a
resting LIMIT back at the range edge. This page records why, what changed, and how to re-run the
measurement.

## What happened on DEMO (30 Oct – 9 Nov 2026)

| Step | Count |
|---|---|
| Analysis rounds | 2,237 |
| Rounds with a setup (confidence ≥ 6) | 203 |
| Orders sent | 53 |
| Orders filled | 16 — duplicates of the same setup at the same price; 5 distinct setups |
| Winning trades | 0 |

Gold and USDJPY orders never filled (price did not come back to the edge). The EURUSD and GBPUSD
fills were all stopped out or closed flat: −$516 and −$755.

A further 360 rounds (16%) ended as *"cTrader not authorized"*: the socket stayed open for hours
with the account never signed in and nothing reconnected. See the watchdog below.

## Why a LIMIT at the edge cannot work

A breakout that runs does not come back to the edge, so the order never fills. A breakout that
comes back is failing, so the order fills exactly when the trade is going wrong. This is the
adverse-selection problem of limit fills (DeLise 2024, *The Negative Drift of a Limit Order Fill*).
The 5-minute replay shows it directly:

| 60 trading days, 5m bars, London 03–05 ET | Gold | EURUSD | GBPUSD | USDJPY |
|---|---|---|---|---|
| Breakouts that never retested, won when entered at the close | 46% | 73% | 87% | 67% |
| LIMIT at the edge: filled trades that reached TP | 5% | 8% | 9% | 0% |
| LIMIT at the edge: avg R per trade (live spreads) | +0.13 (from breakeven exits) | −0.32 | −0.13 | −0.20 |

On top of that the SL of 1.4×ATR(5m) sat inside the noise of a retest (EURUSD 3.5 pips, GBPUSD
4.4 pips, gold $6.3) and a live spread took 35–41% of that risk on EUR/GBP before the trade began.

## What the replay says works

Same setup, same SL and TP, only the entry changed (live spreads: gold $0.30, EUR 1.2, GBP 1.8,
JPY 1.2 pips; breakeven at +1R; one trade per side per day):

| London 02–05 ET, STOP at the breakout close | TP | BE | SL | avg R |
|---|---|---|---|---|
| EURUSD | 52% | 22% | 26% | **+0.30** |
| GBPUSD | 59% | 21% | 21% | **+0.35** |
| USDJPY | 45% | 17% | 38% | +0.19 |
| Gold (GC=F) | 42% | 12% | 46% | +0.15 |

The same entry during the NY overlap (09–12 ET) lost on every instrument (−0.10 … −0.28 R; GBPUSD
+0.05). The two-week replay on the real cTrader feed points the same way (London +0.5 … +1.0 R,
NY −0.1 … −0.7 R, small samples).

Also measured and **not** adopted:

- RVOL ≥ 1.2 as a veto on the break bar: on gold futures (the only feed with volume) the high-RVOL
  breaks did *worse* (40% vs 62% won). The intraday mode had thrown away 182 of ~400 rounds on it.
  It now adds one point of confidence instead.
- Sweep-fade mean reversion at the Asian high/low: negative in every window over these 60 days.
- EMA20 pullback continuation: marginal on gold (53%, PF 1.08), negative on FX after spread.
- "High win rate" variant (SL 2.5×ATR, TP 1R): 71% winners on EUR/GBP with about the same
  expectancy (+0.25 … +0.27 R) — win rate is a design choice, not an edge.

## What changed

| Area | Before | After |
|---|---|---|
| scalp #2 entry | LIMIT at the range edge, valid 45 min | STOP 0.1×ATR past the first 5m close beyond the edge (< 0.75×ATR beyond it), valid 2 h; market if price is already through, skipped if more than 25% of the SL distance past it |
| intraday #2 entry | LIMIT at the range edge, valid 6 h | STOP 0.05×ATR(1h) past the last closed 15m bar, valid 2 h; same market fallback |
| SL / TP | unchanged | unchanged (edge ∓ 1.4×ATR(5m) / 1.0–1.5×ATR(1h); TP 1.5R / max(1.5×range, 1.8R)); breakeven at +1R unchanged |
| Trades per day | one working order per mode, replaced every round | one breakout trade per side per instrument per day (`#2` playbooks only) |
| Scalp window | 03–05 and 08–12 ET | 02–05 ET (London open only) |
| Intraday new entries | 02:30–12:30 ET | 02:30–07:00 ET; open positions are managed all day |
| RVOL ≥ 1.2 on the intraday break bar | veto | +1 confidence |
| XAUUSD modes | scalp, intraday | intraday (scalp back with `GOLD_MODES_XAUUSD=scalp,intraday`) |
| cTrader sign-in | nothing re-tried a session that never authorized | handshake timeout 20 s, account must authorize within 30 s of connecting, sign-in errors logged and retried with 5 s → 60 s backoff, token-invalidated/disconnect events reconnect |

The AI assist checks trades against the playbook text, so the playbook strings in
`src/gold/domain/gold-modes.ts` and `fx-modes.ts` describe the new entry too.

## Limits of the evidence

60 trading days (49 for gold futures), 23–42 trades per cell, so ±8–10 points on any win rate.
September–November 2026 was a trending market (gold near $4,000). Yahoo GC=F is futures, not spot.
Rules were replayed one at a time, without the companion veto or round-number adjustments. No
slippage around news. Treat the result as a direction, confirmed or not by the next weeks on DEMO:
`archive/` keeps every round and `GET /api/dashboard/history` the closed trades.

## Re-running it

`tools/replay/breakout_replay.py` — pure python, no dependencies; the header lists the two `curl`
commands that fetch the data.

## Follow-up, 10–13 November 2026

Three London sessions after the change. The TA found 31 range-break signals; **the AI assist
(strictness `strict`) vetoed 28**, one more was dropped after an AI adjustment cut its R:R, and 2
orders went out (one expired unfilled, one won +1.79R / +$634).

Simulated on the real cTrader M5 bars (STOP valid 2 h, SL/TP as sent, breakeven at +1R), the
first signal per instrument, side and day:

| Signal | AI | What the market did |
|---|---|---|
| 10 Nov GBPUSD scalp BUY | veto | STOP never triggered |
| 10 Nov EURUSD intraday BUY | veto | SL −1R |
| 11 Nov GBPUSD scalp SELL | adjusted, R:R too low | TP +2.08R |
| 11 Nov EURUSD intraday SELL | sent | TP +1.79R (real) |
| 11 Nov GBPUSD intraday SELL | veto | TP +1.80R |
| 11 Nov EURUSD scalp SELL | veto | TP +1.49R |
| 11 Nov USDJPY intraday BUY | veto | TP +1.80R |
| 12 Nov USDJPY scalp BUY | veto | SL −1R |
| 12 Nov XAUUSD intraday SELL | veto | TP +2.45R |

8 fills: 6 TP, 2 SL, +9.4R in total; the AI let through +1.8R of it. Its stated reason on the
winners was the instrument rule "TP1 must not cross the next figure / previous-day high-low",
which caps a breakout target in front of levels a holding break runs through. The rest of the
vetoes were the TA re-issuing the same break every 5–15 minutes for hours after the first one
had been blocked — correctly called late.

Changes:

- **First break only.** A range break is a trade only on its first signal per instrument, mode
  and side per UTC day (loop rounds; manual analysis does not use it up). Later signals are
  `NO_TRADE` with the time of the first. This is the rule the replay measured.
- **Assist prompt.** For scalp #2 / intraday #2 the AI may not adjust or veto because TP1
  crosses a round number or prior-day level, nor call the entry late; it may veto for a major
  release inside the horizon, a data error, or clearly opposing companions.
- **Setting.** AI decision mode set to *TA only*, the configuration the replay measured.
  Switch it back on the dashboard (AI → decision mode) at any time.

9 signals are far too few to rate the AI in general — the point is narrower: the one rule it
applied most often is not part of the measured strategy and cut every one of these breakouts.

Separately, 242 rounds (20%) were again "cTrader not authorized". The macOS power log shows the
Mac asleep 05:00–15:00 BKK with brief Power Nap wake-ups at those times — there is no network
during them, so no client can stay signed in. Keep the machine awake while the loop runs
(`caffeinate -i -w <service pid>`) or run the bot on the server.
