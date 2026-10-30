import Box from '@mui/material/Box';
import type { ReactNode } from 'react';
import { capsLabel } from '../theme/theme';

/** compact page title bar with optional controls on the right */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        px: 3,
        minHeight: 36,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        flexShrink: 0,
      }}
    >
      <Box
        component="h1"
        sx={{ ...capsLabel, m: 0, fontSize: 12, color: 'primary.main' }}
      >
        {title}
      </Box>
      {subtitle ? (
        <Box sx={{ color: 'text.secondary', fontSize: 11.5 }}>{subtitle}</Box>
      ) : null}
      <Box sx={{ flex: 1 }} />
      {actions}
    </Box>
  );
}

/** padded scroll area for a page body */
export function PageBody({
  children,
  grid = false,
}: {
  children: ReactNode;
  grid?: boolean;
}) {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        p: 2,
        ...(grid ? { display: 'grid', gap: 2 } : {}),
      }}
    >
      {children}
    </Box>
  );
}
