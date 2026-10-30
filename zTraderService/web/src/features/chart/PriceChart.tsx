import Box from '@mui/material/Box';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { ChartBar } from '../../api/types';
import { tokensFor } from '../../theme/theme';
import { FONT_MONO } from '../../theme/tokens';

export interface PriceLevel {
  id: string;
  price: number;
  title: string;
  kind: 'entry' | 'sl' | 'tp' | 'pending';
}

export interface PriceChartHandle {
  update: (bar: ChartBar) => void;
}

const toCandle = (b: ChartBar) => ({
  time: b.time as UTCTimestamp,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
});

/** TradingView lightweight-charts candles + volume, themed for the dark/light scheme, with price lines */
export function PriceChart({
  bars,
  digits,
  scheme,
  levels,
  resetKey,
  ref,
}: {
  bars: readonly ChartBar[];
  digits: number;
  scheme: 'dark' | 'light';
  levels: readonly PriceLevel[];
  /** fit the view again when this changes (symbol / source / timeframe) */
  resetKey: string;
  ref?: Ref<PriceChartHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const lastTime = useRef(0);
  const fittedFor = useRef('');

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6 },
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.22 } },
    });
    candles.current = c.addSeries(CandlestickSeries, {});
    volume.current = c.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
    });
    c.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      lines.current = [];
    };
  }, []);

  // theme and price format
  useEffect(() => {
    const t = tokensFor(scheme);
    chart.current?.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: t.panel },
        textColor: t.muted,
        fontSize: 11,
        fontFamily: FONT_MONO,
      },
      grid: { vertLines: { color: t.border }, horzLines: { color: t.border } },
      rightPriceScale: { borderColor: t.borderStrong },
      timeScale: { borderColor: t.borderStrong },
    });
    candles.current?.applyOptions({
      upColor: t.candleUp,
      downColor: t.candleDown,
      wickUpColor: t.candleUp,
      wickDownColor: t.candleDown,
      borderVisible: false,
      priceFormat: {
        type: 'price',
        precision: digits,
        minMove: 1 / 10 ** digits,
      },
    });
  }, [scheme, digits]);

  // full data
  useEffect(() => {
    const t = tokensFor(scheme);
    candles.current?.setData(bars.map(toCandle));
    volume.current?.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? `${t.candleUp}55` : `${t.candleDown}55`,
      })),
    );
    lastTime.current = bars.at(-1)?.time ?? 0;
    if (bars.length && fittedFor.current !== resetKey) {
      fittedFor.current = resetKey;
      chart.current?.timeScale().fitContent();
    }
  }, [bars, resetKey, scheme]);

  // levels
  useEffect(() => {
    const s = candles.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    const t = tokensFor(scheme);
    const color = { entry: t.info, sl: t.down, tp: t.up, pending: t.accent };
    lines.current = levels.map((l) =>
      s.createPriceLine({
        price: l.price,
        color: color[l.kind],
        lineWidth: 1,
        lineStyle:
          l.kind === 'entry'
            ? LineStyle.Solid
            : l.kind === 'pending'
              ? LineStyle.Dotted
              : LineStyle.Dashed,
        axisLabelVisible: true,
        title: l.title,
      }),
    );
  }, [levels, scheme]);

  useImperativeHandle(
    ref,
    () => ({
      update: (bar: ChartBar) => {
        if (!candles.current || bar.time < lastTime.current) return;
        const t = tokensFor(scheme);
        candles.current.update(toCandle(bar));
        volume.current?.update({
          time: bar.time as UTCTimestamp,
          value: bar.volume,
          color:
            bar.close >= bar.open ? `${t.candleUp}55` : `${t.candleDown}55`,
        });
        lastTime.current = bar.time;
      },
    }),
    [scheme],
  );

  return (
    <Box
      ref={host}
      data-testid="price-chart"
      sx={{ position: 'absolute', inset: 0 }}
    />
  );
}
