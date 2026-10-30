import Box from '@mui/material/Box';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { EmptyState } from '../../components/States';
import type { LogLevel } from './activityLog';
import { useLogLines } from './ActivityLogContext';
import { FONT_MONO } from '../../theme/tokens';

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: 'text.primary',
  warn: 'warning.main',
  error: 'terminal.down',
  order: 'terminal.up',
};

/** System Log: server activity + UI actions, virtualized, sticks to the bottom while you are there */
export function ActivityLogView() {
  const { lines } = useLogLines();
  const parent = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // TanStack Virtual returns fresh functions each render; the compiler skips this component
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 20,
    // first paint (and jsdom) before the scroll element is measured
    initialRect: { width: 800, height: 400 },
    overscan: 12,
  });

  useEffect(() => {
    if (stick.current && lines.length)
      v.scrollToIndex(lines.length - 1, { align: 'end' });
  }, [lines.length, v]);

  if (!lines.length) return <EmptyState>Waiting for activity…</EmptyState>;
  return (
    <Box
      ref={parent}
      role="log"
      aria-label="System log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      sx={{
        height: '100%',
        overflow: 'auto',
        fontFamily: FONT_MONO,
        fontSize: 11,
      }}
    >
      <Box sx={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((item) => {
          const l = lines[item.index];
          if (!l) return null;
          return (
            <Box
              key={l.key}
              data-index={item.index}
              ref={v.measureElement}
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${item.start}px)`,
                display: 'flex',
                gap: 1.5,
                px: 2,
                py: 0.25,
                lineHeight: 1.5,
                color: LEVEL_COLOR[l.level],
              }}
            >
              <Box
                component="span"
                sx={{ color: 'text.secondary', flexShrink: 0 }}
              >
                {l.time}
              </Box>
              {l.tag ? (
                <Box
                  component="span"
                  sx={{ color: 'primary.main', flexShrink: 0 }}
                >
                  [{l.tag}]
                </Box>
              ) : null}
              <Box component="span" sx={{ wordBreak: 'break-word' }}>
                {l.message}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
