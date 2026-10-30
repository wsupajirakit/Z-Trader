import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import type { ReactNode } from 'react';
import { ColorModeToggle } from '../../theme/ColorModeToggle';
import { capsLabel } from '../../theme/theme';

/** centred card for login / password screens */
export function AuthScreen({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        bgcolor: 'background.default',
        p: 4,
        position: 'relative',
      }}
    >
      <Box sx={{ position: 'absolute', top: 12, right: 12 }}>
        <ColorModeToggle />
      </Box>
      <Paper sx={{ width: '100%', maxWidth: 480, p: 8 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 5 }}>
          <Box
            sx={{
              width: 28,
              height: 28,
              bgcolor: 'primary.main',
              color: '#fff',
              fontWeight: 800,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 0.5,
            }}
          >
            Z
          </Box>
          <Box>
            <Box sx={{ ...capsLabel, fontSize: 13, letterSpacing: '0.16em' }}>
              Z Trader
            </Box>
            <Box sx={{ fontSize: 11, color: 'text.secondary' }}>{title}</Box>
          </Box>
        </Box>
        {children}
      </Paper>
    </Box>
  );
}
