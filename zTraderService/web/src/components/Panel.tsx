import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { capsLabel } from '../theme/theme';

type SxItem = Exclude<SxProps<Theme>, readonly unknown[]>;
function asList(sx: SxProps<Theme> | undefined): SxItem[] {
  if (!sx) return [];
  return (Array.isArray(sx) ? sx : [sx]) as SxItem[];
}

/**
 * The terminal panel: a bordered box with a compact accent-coloured caps title bar (actions on the right)
 * and a body that scrolls on its own. `dragHandle` marks the title bar as the Launchpad drag handle.
 */
export function Panel({
  title,
  actions,
  children,
  dense = false,
  scroll = true,
  dragHandle = false,
  sx,
  bodySx,
  'aria-label': ariaLabel,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  dense?: boolean;
  scroll?: boolean;
  dragHandle?: boolean;
  sx?: SxProps<Theme>;
  bodySx?: SxProps<Theme>;
  'aria-label'?: string;
}) {
  return (
    <Paper
      component="section"
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
      sx={[
        {
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          height: '100%',
          overflow: 'hidden',
        },
        ...asList(sx),
      ]}
    >
      <Box
        className={dragHandle ? 'zt-drag-handle' : undefined}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minHeight: 30,
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'terminal.panelAlt',
          cursor: dragHandle ? 'move' : undefined,
          flexShrink: 0,
        }}
      >
        <Box
          component="h2"
          sx={{
            ...capsLabel,
            m: 0,
            fontSize: 10.5,
            color: 'primary.main',
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </Box>
        {actions ? (
          <Box
            sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            {actions}
          </Box>
        ) : null}
      </Box>
      <Box
        sx={[
          {
            flex: 1,
            minHeight: 0,
            overflow: scroll ? 'auto' : 'hidden',
            p: dense ? 0 : 2,
          },
          ...asList(bodySx),
        ]}
      >
        {children}
      </Box>
    </Paper>
  );
}

/** label/value row used in compact stat blocks */
export function Stat({
  label,
  value,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'up' | 'down' | 'warn' | 'muted';
}) {
  const color =
    tone === 'up'
      ? 'terminal.up'
      : tone === 'down'
        ? 'terminal.down'
        : tone === 'warn'
          ? 'warning.main'
          : tone === 'muted'
            ? 'text.secondary'
            : 'text.primary';
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 2,
        py: 0.5,
        fontSize: 12,
      }}
    >
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}
      </Box>
      <Box
        component="span"
        className="num"
        sx={{ color, fontWeight: 600, textAlign: 'right' }}
      >
        {value}
      </Box>
    </Box>
  );
}
