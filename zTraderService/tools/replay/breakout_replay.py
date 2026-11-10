"""
Replay of the Asian-range break rules on 5-minute bars — the evidence behind the November 2026
change from "LIMIT at the range edge" to "STOP with the break" (see docs/breakout-entry.md).

Pure python, no dependencies. Everything is measured in R (risk units) with one round-trip
spread deducted per trade. Same-bar SL+TP counts as a loss. Breakeven at +1R mirrors the bot.

Data (put the files next to this script, then `python3 -I breakout_replay.py`):

  Yahoo 5m, last 60 days (gold futures GC=F has volume; the FX pairs do not):
    for s in GC%3DF EURUSD%3DX GBPUSD%3DX JPY%3DX; do
      curl -s -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=5m&range=60d" -o "y_$s.json"
    done
  cTrader M5 (2000 bars = ~2 weeks) through the running service, signed in as any user:
    curl -s -b cookies.txt "http://localhost:6500/api/chart/bars?symbol=XAUUSD&source=ctrader&tf=M5&limit=2000" -o ct_XAUUSD_M5.json
    (same for EURUSD, GBPUSD, USDJPY)

Variants: A = the bot before the change (LIMIT at the edge, SL 1.4×ATR, TP 1.5R, BE +1R) ·
B = retest-confirmed close entry · C = STOP/market at the breakout close (the bot after the change) ·
D = sweep-fade mean reversion · E = EMA20 pullback continuation. Sessions are New York time.
"""

import json, sys, math, statistics, collections
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')

# ---------- data ----------
def load_yahoo(path):
    d = json.load(open(path))['chart']['result'][0]
    ts = d['timestamp']; q = d['indicators']['quote'][0]
    out = []
    for i, t in enumerate(ts):
        if q['open'][i] is None or q['close'][i] is None: continue
        out.append(dict(ts=t, o=q['open'][i], h=q['high'][i], l=q['low'][i], c=q['close'][i], v=q['volume'][i] or 0))
    return out

def load_ct(path):
    d = json.load(open(path)); b = d.get('bars') if isinstance(d, dict) else d
    return [dict(ts=x['time'], o=x['open'], h=x['high'], l=x['low'], c=x['close'], v=x.get('volume') or 0) for x in b]

# ---------- indicators ----------
def ema(vals, n):
    k = 2 / (n + 1); out = []; e = None
    for v in vals:
        e = v if e is None else v * k + e * (1 - k)
        out.append(e)
    return out

def atr14(bars):
    out = []; a = None; prev = None
    for b in bars:
        tr = b['h'] - b['l'] if prev is None else max(b['h'] - b['l'], abs(b['h'] - prev['c']), abs(b['l'] - prev['c']))
        a = tr if a is None else (a * 13 + tr) / 14
        out.append(a); prev = b
    return out

def enrich(bars):
    closes = [b['c'] for b in bars]
    e20, e50, e200, at = ema(closes, 20), ema(closes, 50), ema(closes, 200), atr14(bars)
    vols = [b['v'] for b in bars]
    for i, b in enumerate(bars):
        b['ema20'], b['ema50'], b['ema200'], b['atr'] = e20[i], e50[i], e200[i], at[i]
        w = vols[max(0, i - 20):i]
        b['rvol'] = (b['v'] / (sum(w) / len(w))) if w and sum(w) > 0 else 1.0
    # 15m context (EMA20 vs EMA50 of 15m closes), assigned to each 5m bar from the last CLOSED 15m bar
    m15 = collections.OrderedDict()
    for b in bars:
        k = b['ts'] // 900
        m15.setdefault(k, []).append(b['c'])
    keys = list(m15.keys()); c15 = [m15[k][-1] for k in keys]
    f20, f50 = ema(c15, 20), ema(c15, 50)
    bull = {k: f20[i] > f50[i] for i, k in enumerate(keys)}
    kidx = {k: i for i, k in enumerate(keys)}
    for b in bars:
        k = b['ts'] // 900
        i = kidx[k]
        b['bull15'] = bull[keys[i - 1]] if i > 0 else None  # last closed 15m
    return bars

def et(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(ET)

def et_min(ts):
    d = et(ts); return d.hour * 60 + d.minute, d.weekday()  # weekday: Mon=0

SCALP_WIN = [(180, 300), (480, 720)]
BLACKOUT = [(480, 540)]
def in_scalp_window(ts, jpy=False):
    m, dow = et_min(ts)
    if dow >= 5: return False
    if dow == 4 and m >= 720: return False
    if any(a <= m < b for a, b in BLACKOUT): return False
    wins = SCALP_WIN + ([(19 * 60, 21 * 60)] if jpy else [])
    return any(a <= m < b for a, b in wins)

# ---------- trading days & asian range (bot: 23:00-07:00 UTC, usable from 07:10 UTC) ----------
def trading_days(bars):
    """yield (day_utc_date, asian_hi, asian_lo, index of first bar >= 07:10 UTC, index of bar < next 23:00 UTC)"""
    byday = collections.OrderedDict()
    for i, b in enumerate(bars):
        d = datetime.fromtimestamp(b['ts'], tz=timezone.utc)
        byday.setdefault(d.date(), []).append(i)
    days = list(byday.keys())
    for di, day in enumerate(days):
        start = datetime(day.year, day.month, day.day, 7, 0, tzinfo=timezone.utc).timestamp()
        a0 = start - 8 * 3600
        win = [bars[i] for i in byday[day] + (byday[days[di - 1]] if di > 0 else []) if a0 <= bars[i]['ts'] < start]
        if len(win) < 10: continue
        hi, lo = max(b['h'] for b in win), min(b['l'] for b in win)
        idx = [i for i in byday[day] if bars[i]['ts'] >= start + 600]
        if not idx: continue
        end = start + 16 * 3600  # until 23:00 UTC
        yield day, hi, lo, idx[0], end

# ---------- trade resolution ----------
def resolve(bars, i0, side, entry, sl, tp, be=True, max_bars=600, spread=0.0):
    """walk forward from bar i0 (inclusive). returns (R, exit, bars_held). same-bar SL+TP = loss (conservative)."""
    risk = (entry - sl) * side
    cur_sl = sl; be_done = False
    for j in range(i0, min(len(bars), i0 + max_bars)):
        b = bars[j]
        hit_sl = (b['l'] <= cur_sl) if side > 0 else (b['h'] >= cur_sl)
        hit_tp = (b['h'] >= tp) if side > 0 else (b['l'] <= tp)
        if hit_sl:
            return ((cur_sl - entry) * side - spread) / risk, 'BE' if be_done else 'SL', j - i0
        if hit_tp:
            return ((tp - entry) * side - spread) / risk, 'TP', j - i0
        if be and not be_done:
            prog = ((b['h'] if side > 0 else b['l']) - entry) * side / risk
            if prog >= 1.0:
                cur_sl = entry + side * 0.1 * risk; be_done = True
    b = bars[min(len(bars) - 1, i0 + max_bars - 1)]
    return ((b['c'] - entry) * side - spread) / risk, 'TIME', max_bars

def stats(trades, label):
    if not trades: return f"{label:<46} n=0"
    R = [t[0] for t in trades]
    w = [r for r in R if r > 0.05]; l = [r for r in R if r <= 0.05]
    pf = (sum(w) / -sum(l)) if l and sum(l) < 0 else float('inf')
    kinds = collections.Counter(t[1] for t in trades)
    return (f"{label:<46} n={len(R):4d}  win%={100*len(w)/len(R):5.1f}  avgR={statistics.mean(R):+.3f}  "
            f"PF={pf:4.2f}  sumR={sum(R):+7.1f}  {dict(kinds)}")

# ---------- strategies ----------
def bot_scalp2(bars, cfg, mode='limit', sl_mult=1.4, rr=1.5, be=True, jpy=False, spread=0.0, cap=None, valid_min=45):
    """mode: 'limit' = resting LIMIT at the range edge (bot) · 'stop' = market at the first qualifying close
    · 'confirm' = wait for a retest bar (touches the edge) that closes back in the breakout direction, enter at its close"""
    trades = []; placed = 0; filled = 0
    for day, rH, rL, i0, end in trading_days(bars):
        rng = rH - rL
        done = set()
        for side, edge in ((1, rH), (-1, rL)):
            order = None  # (entry, sl, tp, last_place_ts)
            i = i0
            while i < len(bars) and bars[i]['ts'] < end:
                b = bars[i]; atr = b['atr']
                if side in done: break
                if in_scalp_window(b['ts'], jpy) and b['bull15'] is not None and ((side > 0) == b['bull15']):
                    beyond = (b['c'] - edge) * side
                    if 0.1 * atr < beyond < 1.0 * rng:
                        entry = edge
                        sl = entry - side * sl_mult * atr
                        risk = (entry - sl) * side
                        tpd = max(rr * risk, min(1.5 * rng, cap if cap else 1e9))
                        tp = entry + side * tpd
                        if mode == 'stop':
                            entry2 = b['c']; sl2 = sl; risk2 = (entry2 - sl2) * side
                            tp2 = entry2 + side * rr * risk2
                            r = resolve(bars, i + 1, side, entry2, sl2, tp2, be, spread=spread)
                            trades.append(r); placed += 1; filled += 1; done.add(side); break
                        if order is None: placed += 1
                        order = (entry, sl, tp, b['ts'])
                if order and mode in ('limit', 'confirm'):
                    entry, sl, tp, t0 = order
                    if b['ts'] > t0 + valid_min * 60:
                        order = None
                    else:
                        touched = (b['l'] <= entry) if side > 0 else (b['h'] >= entry)
                        if touched and b['ts'] > t0:
                            if mode == 'limit':
                                filled += 1
                                r = resolve(bars, i, side, entry, sl, tp, be, spread=spread)
                                trades.append(r); done.add(side); break
                            else:  # confirm: bar must close back on the breakout side of the edge
                                if (b['c'] - edge) * side > 0:
                                    filled += 1
                                    entry2 = b['c']; risk2 = (entry2 - sl) * side
                                    tp2 = entry2 + side * max(rr * risk2, min(1.5 * rng, cap if cap else 1e9))
                                    r = resolve(bars, i + 1, side, entry2, sl, tp2, be, spread=spread)
                                    trades.append(r); done.add(side); break
                i += 1
    return trades, placed, filled

def sweep_fade(bars, rr=1.0, sl_buf=0.3, hours=None, spread=0.0, be=False, levels='asian'):
    """price pokes beyond the Asian high/low (or prev-day high/low) then the 5m bar closes back inside -> fade at close"""
    trades = []
    prev_day = None
    for day, rH, rL, i0, end in trading_days(bars):
        lv = [(rH, -1), (rL, 1)]
        if levels == 'pdh' and prev_day: lv = [(prev_day[0], -1), (prev_day[1], 1)]
        used = set()
        i = i0
        while i < len(bars) and bars[i]['ts'] < end:
            b = bars[i]; atr = b['atr']
            m, dow = et_min(b['ts'])
            ok_hour = (hours is None or any(a <= m < z for a, z in hours)) and dow < 5 and not any(a <= m < z for a, z in BLACKOUT)
            if ok_hour:
                for lvl, side in lv:
                    if (lvl, side) in used: continue
                    poke = (b['h'] - lvl) if side < 0 else (lvl - b['l'])
                    back = (b['c'] < lvl) if side < 0 else (b['c'] > lvl)
                    if poke >= 0.15 * atr and back:
                        entry = b['c']
                        sl = (b['h'] + sl_buf * atr) if side < 0 else (b['l'] - sl_buf * atr)
                        risk = (entry - sl) * side
                        if risk <= 0: continue
                        tp = entry + side * rr * risk
                        trades.append(resolve(bars, i + 1, side, entry, sl, tp, be, max_bars=96, spread=spread))
                        used.add((lvl, side))
            i += 1
        # prev-day high/low for the next day = full-day range
        dayb = [x for x in bars[i0:] if x['ts'] < end]
        if dayb: prev_day = (max(x['h'] for x in dayb), min(x['l'] for x in dayb))
    return trades

def ema_pullback(bars, rr=1.0, hours=None, spread=0.0, be=False):
    trades = []; last = -100
    for i in range(210, len(bars) - 1):
        b = bars[i]; m, dow = et_min(b['ts'])
        if dow >= 5 or i - last < 6: continue
        if hours and not any(a <= m < z for a, z in hours): continue
        if any(a <= m < z for a, z in BLACKOUT): continue
        for side in (1, -1):
            trend = (b['ema50'] > b['ema200']) if side > 0 else (b['ema50'] < b['ema200'])
            touch = (b['l'] <= b['ema20'] <= b['h'])
            closed_ok = (b['c'] > b['ema20'] and b['c'] > b['o']) if side > 0 else (b['c'] < b['ema20'] and b['c'] < b['o'])
            if trend and touch and closed_ok:
                lows = bars[i - 3:i + 1]
                sl = (min(x['l'] for x in lows) - 0.2 * b['atr']) if side > 0 else (max(x['h'] for x in lows) + 0.2 * b['atr'])
                entry = b['c']; risk = (entry - sl) * side
                if risk < 0.5 * b['atr']: sl = entry - side * 0.5 * b['atr']; risk = 0.5 * b['atr']
                tp = entry + side * rr * risk
                trades.append(resolve(bars, i + 1, side, entry, sl, tp, be, max_bars=96, spread=spread))
                last = i
    return trades

def retest_stats(bars, jpy=False):
    """after the bot's trigger (5m close beyond edge by >0.1 ATR, 15m aligned, inside the scalp window):
    does price come back to the edge within 45 min / 2 h, and what happens next?"""
    out = collections.Counter(); n = 0
    for day, rH, rL, i0, end in trading_days(bars):
        rng = rH - rL
        for side, edge in ((1, rH), (-1, rL)):
            for i in range(i0, len(bars)):
                b = bars[i]
                if b['ts'] >= end: break
                if not in_scalp_window(b['ts'], jpy) or b['bull15'] is None or ((side > 0) != b['bull15']): continue
                beyond = (b['c'] - edge) * side
                if not (0.1 * b['atr'] < beyond < 1.0 * rng): continue
                n += 1
                sl = edge - side * 1.4 * b['atr']; tp = edge + side * max(1.5 * 1.4 * b['atr'], 1.5 * rng)
                ret45 = ret120 = None
                for j in range(i + 1, min(len(bars), i + 25)):
                    x = bars[j]
                    touched = (x['l'] <= edge) if side > 0 else (x['h'] >= edge)
                    if touched:
                        if x['ts'] <= b['ts'] + 45 * 60 and ret45 is None: ret45 = j
                        if ret120 is None: ret120 = j
                        break
                out['trigger'] += 1
                if ret45 is not None: out['retest<=45m'] += 1
                if ret120 is not None: out['retest<=2h'] += 1
                # outcome from the trigger close (stop entry) and from the retest (limit entry)
                r_stop = resolve(bars, i + 1, side, b['c'], sl, b['c'] + side * 1.5 * ((b['c'] - sl) * side), True)
                out['stop_win'] += r_stop[0] > 0.05
                if ret45 is not None:
                    r_lim = resolve(bars, ret45, side, edge, sl, tp, True)
                    out['limit_win'] += r_lim[0] > 0.05; out['limit_n'] += 1
                else:
                    out['noretest_win'] += r_stop[0] > 0.05; out['noretest_n'] += 1
                break  # one trigger per side per day
    return out

def hourly_profile(bars):
    acc = collections.defaultdict(list)
    for b in bars:
        acc[et(b['ts']).hour].append((b['h'] - b['l']) / b['atr'] if b['atr'] else 0)
    return {h: round(statistics.mean(v), 2) for h, v in sorted(acc.items())}

# ---------- run ----------
SETS = {
    'GOLD  yahoo GC=F 60d': ('y_GC%3DF.json', 'yahoo', 0.30, 4.0, False),
    'EURUSD yahoo 60d': ('y_EURUSD%3DX.json', 'yahoo', 0.00012, 0.0012, False),
    'GBPUSD yahoo 60d': ('y_GBPUSD%3DX.json', 'yahoo', 0.00018, 0.0015, False),
    'USDJPY yahoo 60d': ('y_JPY%3DX.json', 'yahoo', 0.012, 0.12, True),
    'XAUUSD cTrader 2w': ('ct_XAUUSD_M5.json', 'ct', 0.10, 4.0, False),
    'EURUSD cTrader 2w': ('ct_EURUSD_M5.json', 'ct', 0.00002, 0.0012, False),
    'GBPUSD cTrader 2w': ('ct_GBPUSD_M5.json', 'ct', 0.00002, 0.0015, False),
    'USDJPY cTrader 2w': ('ct_USDJPY_M5.json', 'ct', 0.002, 0.12, True),
}
LONDON = [(120, 300)]; LULL = [(300, 480)]; NY = [(540, 720)]; ASIA = [(19 * 60, 24 * 60), (0, 120)]

for name, (path, kind, spread, cap, jpy) in SETS.items():
    bars = enrich(load_yahoo(path) if kind == 'yahoo' else load_ct(path))
    days = sum(1 for _ in trading_days(bars))
    print(f"\n===== {name}: {len(bars)} bars, {days} trading days, spread {spread} =====")
    rs = retest_stats(bars, jpy)
    t = rs['trigger'] or 1
    print(f"bot trigger (close beyond edge, 15m aligned, in window): {rs['trigger']} ({rs['trigger']/max(days,1):.2f}/day)"
          f" | retest edge <=45m: {100*rs['retest<=45m']/t:.0f}%  <=2h: {100*rs['retest<=2h']/t:.0f}%"
          f" | LIMIT-at-retest win%: {100*rs['limit_win']/max(rs['limit_n'],1):.0f} (n={rs['limit_n']})"
          f" | no-retest breakouts won (stop entry) {100*rs['noretest_win']/max(rs['noretest_n'],1):.0f}% (n={rs['noretest_n']})"
          f" | stop-entry win% overall {100*rs['stop_win']/t:.0f}")
    tr, placed, filled = bot_scalp2(bars, None, 'limit', jpy=jpy, spread=spread, cap=cap)
    print(stats(tr, f"A bot: LIMIT@edge SL1.4ATR TP1.5R/1.5rng  placed={placed} filled={filled}"))
    tr, placed, filled = bot_scalp2(bars, None, 'limit', sl_mult=3.0, rr=1.0, jpy=jpy, spread=spread, cap=cap)
    print(stats(tr, f"A2 LIMIT@edge, SL 3.0ATR, TP 1R           placed={placed} filled={filled}"))
    tr, placed, filled = bot_scalp2(bars, None, 'confirm', jpy=jpy, spread=spread, cap=cap)
    print(stats(tr, f"B retest-CONFIRM close entry (bot SL/TP)   placed={placed} filled={filled}"))
    tr, placed, filled = bot_scalp2(bars, None, 'confirm', sl_mult=2.5, rr=1.0, jpy=jpy, spread=spread, cap=cap)
    print(stats(tr, f"B2 retest-CONFIRM, SL 2.5ATR, TP 1R         placed={placed} filled={filled}"))
    tr, placed, filled = bot_scalp2(bars, None, 'stop', jpy=jpy, spread=spread, cap=cap)
    print(stats(tr, f"C STOP/market at breakout close, TP1.5R    placed={placed} filled={filled}"))
    tr, placed, filled = bot_scalp2(bars, None, 'stop', sl_mult=2.5, rr=1.0, jpy=jpy, spread=spread, cap=cap)
    print(stats(tr, f"C2 STOP at breakout close, SL2.5ATR TP1R    placed={placed} filled={filled}"))
    for lab, hrs in (('London 02-05ET', LONDON), ('lull 05-08ET', LULL), ('NY 09-12ET', NY), ('Asia 19-02ET', ASIA)):
        print(stats(sweep_fade(bars, rr=1.0, hours=hrs, spread=spread), f"D sweep-fade Asian H/L, TP1R  [{lab}]"))
    print(stats(sweep_fade(bars, rr=1.0, hours=LONDON + LULL + NY, spread=spread, levels='pdh'), "D2 sweep-fade prev-day H/L, TP1R [02-12ET]"))
    print(stats(sweep_fade(bars, rr=1.5, hours=LONDON + LULL + NY, spread=spread), "D3 sweep-fade Asian H/L, TP1.5R [02-12ET]"))
    print(stats(sweep_fade(bars, rr=0.7, hours=LONDON + LULL + NY, spread=spread), "D4 sweep-fade Asian H/L, TP0.7R [02-12ET]"))
    for lab, hrs in (('London+NY', LONDON + NY), ('all 24h', None)):
        print(stats(ema_pullback(bars, rr=1.0, hours=hrs, spread=spread), f"E EMA20 pullback w/ EMA50>200, TP1R [{lab}]"))
    print(stats(ema_pullback(bars, rr=1.5, hours=LONDON + NY, spread=spread, be=True), "E2 EMA20 pullback, TP1.5R+BE [London+NY]"))
    print("hourly 5m range / ATR (ET):", hourly_profile(bars))
