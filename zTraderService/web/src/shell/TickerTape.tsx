import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { TickPrice } from '../api/types';
import { statusQuery } from '../data/queries';
import { useInstruments } from '../data/useInstruments';
import { fmtP } from '../lib/format';
import { capsLabel } from '../theme/theme';
import { terminalStore } from './terminalStore';

type Dir = 'up' | 'down' | null;

/** scrolling-style quote strip: bid/ask of every instrument, flashes green/red on a tick, click to chart it */
export function TickerTape() {
  const { data: status } = useQuery(statusQuery);
  const { symbols, digitsFor, chartSymbol } = useInstruments();
  const prices = status?.prices;
  // direction of the last tick per symbol, derived when a new status arrives (no effect needed)
  const [snap, setSnap] = useState<{
    prices: Record<string, TickPrice | null> | undefined;
    dir: Record<string, Dir>;
  }>({ prices, dir: {} });
  if (snap.prices !== prices) {
    const dir: Record<string, Dir> = {};
    for (const s of symbols) {
      const now = prices?.[s]?.bid;
      const before = snap.prices?.[s]?.bid;
      dir[s] =
        now !== undefined && before !== undefined && now !== before
          ? now > before
            ? 'up'
            : 'down'
          : null;
    }
    setSnap({ prices, dir });
  }
  const flash = snap.dir;

  return (
    <Box
      role="list"
      aria-label="Quotes"
      sx={{
        height: 28,
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: 1,
        borderColor: 'divider',
        overflowX: 'auto',
        flexShrink: 0,
        bgcolor: 'background.default',
      }}
    >
      {symbols.map((s) => {
        const p = prices?.[s] ?? null;
        const d = digitsFor(s);
        const stale = !p || p.age_sec > 60;
        const dir = flash[s] ?? null;
        return (
          <ButtonBase
            key={`${s}-${String(p?.bid ?? '')}`}
            role="listitem"
            onClick={() => {
              terminalStore.set({ chartSymbol: s });
            }}
            aria-label={`${s} bid ${p ? fmtP(p.bid, d) : 'n/a'}`}
            sx={{
              px: 3,
              gap: 2,
              borderRight: 1,
              borderColor: 'divider',
              whiteSpace: 'nowrap',
              fontSize: 11.5,
              opacity: stale ? 0.55 : 1,
              bgcolor: chartSymbol === s ? 'action.selected' : 'transparent',
              // remounted on every tick (key), so the flash plays once per price change
              animation: dir
                ? `${dir === 'up' ? 'ztFlashUp' : 'ztFlashDown'} 800ms ease-out`
                : undefined,
              '@keyframes ztFlashUp': {
                from: { backgroundColor: 'rgba(0,193,118,0.28)' },
                to: { backgroundColor: 'transparent' },
              },
              '@keyframes ztFlashDown': {
                from: { backgroundColor: 'rgba(255,77,79,0.28)' },
                to: { backgroundColor: 'transparent' },
              },
            }}
          >
            <Box
              component="span"
              sx={{ ...capsLabel, color: 'primary.main', fontSize: 11 }}
            >
              {s}
            </Box>
            <Box
              component="span"
              className="num"
              sx={{
                color:
                  dir === 'down'
                    ? 'terminal.down'
                    : dir === 'up'
                      ? 'terminal.up'
                      : 'text.primary',
              }}
            >
              {p ? fmtP(p.bid, d) : '—'}
            </Box>
            <Box
              component="span"
              className="num"
              sx={{ color: 'text.secondary' }}
            >
              {p ? fmtP(p.ask, d) : ''}
            </Box>
            {p ? (
              <Box
                component="span"
                className="num"
                sx={{ color: 'text.secondary', fontSize: 10 }}
              >
                spr {((p.ask - p.bid) * 10 ** (d >= 3 ? d - 1 : d)).toFixed(1)}
              </Box>
            ) : null}
            {stale ? (
              <Box
                component="span"
                sx={{ fontSize: 9, color: 'warning.main', ...capsLabel }}
              >
                {p ? 'delayed' : 'n/a'}
              </Box>
            ) : null}
          </ButtonBase>
        );
      })}
    </Box>
  );
}
