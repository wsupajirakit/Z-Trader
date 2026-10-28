/**
 * Indicator math ported from z-service backend/gold.py (_enrich et al.)
 * so the CSVs this service builds are numerically identical to the ones
 * the dash's purple button produced.
 */
export interface Bar {
    ts: number; // bar open time, ms UTC
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface EnrichedBar extends Bar {
    ema20: number;
    ema50: number;
    ema100: number;
    ema200: number;
    rsi: number;
    obv: number;
    cmf50: number;
    cmf20: number;
    vwap20: number;
    atr14: number;
    rvol20: number;
}

/** pandas ewm(span=n, adjust=False) */
function emaSeries(values: number[], span: number): number[] {
    const alpha = 2 / (span + 1);
    const out = new Array<number>(values.length);
    let prev = values[0] ?? 0;
    for (let i = 0; i < values.length; i++) {
        prev = i === 0 ? values[0] : alpha * values[i] + (1 - alpha) * prev;
        out[i] = prev;
    }
    return out;
}

/** pandas ewm(alpha=1/n, adjust=False) — Wilder smoothing */
function wilderSeries(values: number[], n: number): number[] {
    const alpha = 1 / n;
    const out = new Array<number>(values.length);
    let prev = values[0] ?? 0;
    for (let i = 0; i < values.length; i++) {
        prev = i === 0 ? values[0] : alpha * values[i] + (1 - alpha) * prev;
        out[i] = prev;
    }
    return out;
}

function rollingSum(values: number[], n: number): Array<number | null> {
    const out = new Array<number | null>(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= n) sum -= values[i - n];
        if (i >= n - 1) out[i] = sum;
    }
    return out;
}

export function enrich(bars: Bar[]): EnrichedBar[] {
    const n = bars.length;
    const close = bars.map((b) => b.close);
    const ema20 = emaSeries(close, 20);
    const ema50 = emaSeries(close, 50);
    const ema100 = emaSeries(close, 100);
    const ema200 = emaSeries(close, 200);

    // RSI(14): Wilder-smoothed gains/losses; loss==0 -> 50 (matches fillna(50))
    const gains: number[] = [0],
        losses: number[] = [0];
    for (let i = 1; i < n; i++) {
        const d = close[i] - close[i - 1];
        gains.push(Math.max(d, 0));
        losses.push(Math.max(-d, 0));
    }
    const avgGain = wilderSeries(gains, 14);
    const avgLoss = wilderSeries(losses, 14);
    const rsi = avgGain.map((g, i) => {
        const l = avgLoss[i];
        if (!l) return 50;
        return 100 - 100 / (1 + g / l);
    });

    // OBV
    const obv = new Array<number>(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const d = i === 0 ? 0 : close[i] - close[i - 1];
        acc += bars[i].volume * (d > 0 ? 1 : d < 0 ? -1 : 0);
        obv[i] = acc;
    }

    // CMF: mfv = mfm * volume (0 when high==low); rolling(n) sums
    const mfv = bars.map((b) => {
        const rng = b.high - b.low;
        if (!rng) return 0;
        return ((b.close - b.low - (b.high - b.close)) / rng) * b.volume;
    });
    const vols = bars.map((b) => b.volume);
    const cmfOf = (win: number): number[] => {
        const mfvSum = rollingSum(mfv, win);
        const volSum = rollingSum(vols, win);
        return bars.map((_, i) => (mfvSum[i] == null || !volSum[i] ? 0 : mfvSum[i] / volSum[i]));
    };
    const cmf50 = cmfOf(50);
    const cmf20 = cmfOf(20);

    // ATR14: Wilder ewm over true range
    const tr = bars.map((b, i) => {
        if (i === 0) return b.high - b.low;
        const pc = close[i - 1];
        return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
    const atr14 = wilderSeries(tr, 14);

    // VWAP20 rolling: sum(tpv,20)/sum(vol,20), fallback = close
    const tpv = bars.map((b) => ((b.high + b.low + b.close) / 3) * b.volume);
    const tpvSum = rollingSum(tpv, 20);
    const volSum20 = rollingSum(vols, 20);
    const vwap20 = bars.map((b, i) => (tpvSum[i] == null || !volSum20[i] ? b.close : tpvSum[i] / volSum20[i]));

    // RVOL20: volume / rolling mean(20), fallback = 1
    const rvol20 = bars.map((b, i) => (volSum20[i] == null || !volSum20[i] ? 1 : b.volume / (volSum20[i] / 20)));

    return bars.map((b, i) => ({
        ...b,
        ema20: ema20[i],
        ema50: ema50[i],
        ema100: ema100[i],
        ema200: ema200[i],
        rsi: rsi[i],
        obv: obv[i],
        cmf50: cmf50[i],
        cmf20: cmf20[i],
        vwap20: vwap20[i],
        atr14: atr14[i],
        rvol20: rvol20[i],
    }));
}
