import Box from '@mui/material/Box';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityLogProvider } from '../features/activity/ActivityLogProvider';
import { CommandBar } from './CommandBar';
import { CommandPalette, ShortcutsDialog } from './CommandPalette';
import { ContextRail } from './ContextRail';
import { DemoBanner } from './DemoBanner';
import { IconRail } from './IconRail';
import { StatusBar } from './StatusBar';
import { terminalStore, useTerminalPrefs } from './terminalStore';
import { TickerTape } from './TickerTape';
import { TopBar } from './TopBar';

const CHORDS: Record<string, string> = {
  t: '/',
  c: '/chart',
  b: '/bot',
  s: '/strategy',
  r: '/trades',
  n: '/news',
};

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable)
  );
}

/**
 * The signed-in layout, after OpenTerminalUI's TerminalShell:
 *   IconRail | CommandBar / TickerTape / TopBar / page + Context Rail / StatusBar
 */
export function TerminalShell() {
  const prefs = useTerminalPrefs();
  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const chord = useRef<number>(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (mod && e.key === '/') {
        e.preventDefault();
        setShortcuts(true);
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        terminalStore.set((p) => ({ contextRail: !p.contextRail }));
      } else if (!mod && !e.altKey && !isTyping(e.target)) {
        const key = e.key.toLowerCase();
        if (key === 'g') {
          chord.current = Date.now();
        } else if (Date.now() - chord.current < 1200 && CHORDS[key]) {
          chord.current = 0;
          void navigate({ to: CHORDS[key] });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [navigate]);

  return (
    <ActivityLogProvider>
      <Box
        sx={{
          display: 'flex',
          height: '100vh',
          bgcolor: 'background.default',
          color: 'text.primary',
        }}
      >
        <IconRail />
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <DemoBanner />
          <CommandBar />
          {prefs.tickerTape ? <TickerTape /> : null}
          <TopBar />
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <Box
              component="main"
              sx={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                overflow: 'auto',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <Outlet />
            </Box>
            <ContextRail />
          </Box>
          <StatusBar />
        </Box>
      </Box>
      <CommandPalette
        open={palette}
        onClose={() => {
          setPalette(false);
        }}
      />
      <ShortcutsDialog
        open={shortcuts}
        onClose={() => {
          setShortcuts(false);
        }}
      />
    </ActivityLogProvider>
  );
}
