import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import InputBase from '@mui/material/InputBase';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import { useMemo, useState } from 'react';
import { useInstruments } from '../data/useInstruments';
import { useCurrentUser } from '../features/auth/session';
import { allCommands } from './commands';
import { useCommandRunner } from './useCommandRunner';

const SHORTCUTS: [string, string][] = [
  ['Ctrl + G', 'Focus the GO bar'],
  ['Ctrl + K', 'Command palette'],
  ['Ctrl + /', 'This shortcut list'],
  ['Ctrl + B', 'Toggle the context rail'],
  ['G then T / C / B / S', 'Go to Terminal / Chart / Bot / Strategy'],
  ['Esc', 'Close dialogs'],
];

/** Ctrl+K palette (fuzzy list of every function and instrument) and Ctrl+/ shortcut list */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      slotProps={{ paper: { sx: { alignSelf: 'flex-start', mt: '12vh' } } }}
    >
      <DialogTitle>Command palette</DialogTitle>
      {open ? <PaletteBody onClose={onClose} /> : null}
    </Dialog>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const user = useCurrentUser();
  const { symbols } = useInstruments();
  const run = useCommandRunner();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const all = allCommands(symbols, user?.role);
    const query = q.trim().toLowerCase();
    if (!query) return all;
    return all.filter((c) =>
      `${c.code} ${c.label} ${c.description}`.toLowerCase().includes(query),
    );
  }, [q, symbols, user?.role]);

  const pick = (i: number) => {
    const c = items[i];
    if (!c) return;
    onClose();
    run(c);
  };

  return (
    <DialogContent sx={{ p: '0 !important' }}>
      <InputBase
        autoFocus
        fullWidth
        value={q}
        placeholder="Search functions and instruments…"
        inputProps={{ 'aria-label': 'Search commands' }}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(sel);
          }
        }}
        sx={{
          px: 4,
          py: 2,
          borderBottom: 1,
          borderColor: 'divider',
          fontSize: 13,
        }}
      />
      <List dense sx={{ maxHeight: 360, overflow: 'auto' }}>
        {items.map((c, i) => (
          <ListItemButton
            key={`${c.kind}-${c.code}`}
            selected={i === sel}
            onClick={() => {
              pick(i);
            }}
            sx={{ gap: 3 }}
          >
            <Box
              className="num"
              sx={{ color: 'primary.main', fontWeight: 700, minWidth: 70 }}
            >
              {c.code}
            </Box>
            <Box sx={{ minWidth: 110 }}>{c.label}</Box>
            <Box sx={{ color: 'text.secondary', fontSize: 11 }}>
              {c.description}
            </Box>
          </ListItemButton>
        ))}
        {!items.length ? (
          <Box sx={{ p: 4, color: 'text.secondary' }}>No match</Box>
        ) : null}
      </List>
    </DialogContent>
  );
}

export function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Keyboard shortcuts</DialogTitle>
      <DialogContent>
        {SHORTCUTS.map(([k, d]) => (
          <Box
            key={k}
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              py: 1,
              borderBottom: 1,
              borderColor: 'divider',
              fontSize: 12,
            }}
          >
            <Box component="kbd">{k}</Box>
            <span>{d}</span>
          </Box>
        ))}
      </DialogContent>
    </Dialog>
  );
}
