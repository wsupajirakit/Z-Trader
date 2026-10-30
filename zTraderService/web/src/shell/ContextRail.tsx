import Box from '@mui/material/Box';
import { Panel } from '../components/Panel';
import { NewsList } from '../features/news/NewsList';
import { PositionsTable } from '../features/positions/PositionsTable';
import { DailyStopCard } from '../features/risk/DailyStopCard';
import { useTerminalPrefs } from './terminalStore';

export const CONTEXT_RAIL_WIDTH = 288;

/** right-hand stack of small panels (OpenTerminalUI's Context Rail): risk, positions, news */
export function ContextRail() {
  const { contextRail } = useTerminalPrefs();
  if (!contextRail) return null;
  return (
    <Box
      component="aside"
      aria-label="Context"
      sx={{
        width: CONTEXT_RAIL_WIDTH,
        flexShrink: 0,
        borderLeft: 1,
        borderColor: 'divider',
        display: { xs: 'none', lg: 'flex' },
        flexDirection: 'column',
        gap: 1,
        p: 1,
        bgcolor: 'background.default',
        minHeight: 0,
      }}
    >
      <Box sx={{ flexShrink: 0 }}>
        <Panel title="Risk today" scroll={false}>
          <DailyStopCard />
        </Panel>
      </Box>
      <Box sx={{ flex: '1 1 40%', minHeight: 0 }}>
        <Panel title="Open positions" dense>
          <PositionsTable compact />
        </Panel>
      </Box>
      <Box sx={{ flex: '1 1 60%', minHeight: 0 }}>
        <Panel title="News">
          <NewsList limit={12} compact />
        </Panel>
      </Box>
    </Box>
  );
}
