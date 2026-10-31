import Box from '@mui/material/Box';
import { useCurrentUser } from '../features/auth/session';
import { capsLabel } from '../theme/theme';

/** always-visible notice for the demo role */
export function DemoBanner() {
  const user = useCurrentUser();
  if (user?.role !== 'demo') return null;
  return (
    <Box
      role="status"
      sx={{
        px: 3,
        py: 0.75,
        bgcolor: 'warning.main',
        color: '#1a1300',
        fontSize: 11.5,
        display: 'flex',
        gap: 2,
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <Box component="span" sx={{ ...capsLabel, fontWeight: 800 }}>
        Demo mode
      </Box>
      <span>
        Everything works, but every action is simulated: no order is sent, no AI
        provider is called and no setting is saved. Run / Analyze use real
        market data.
      </span>
    </Box>
  );
}
