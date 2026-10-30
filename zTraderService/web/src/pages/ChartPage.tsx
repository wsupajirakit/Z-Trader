import Box from '@mui/material/Box';
import { Panel } from '../components/Panel';
import { ChartView } from '../features/chart/ChartView';
import { ModeCards } from '../features/bot/ModeCards';

export function ChartPage() {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateRows: 'minmax(360px, 1fr) auto',
        gap: 2,
        p: 2,
        height: '100%',
        minHeight: 0,
      }}
    >
      <Panel title="Chart" dense scroll={false}>
        <ChartView />
      </Panel>
      <Box sx={{ maxHeight: 280, minHeight: 0 }}>
        <Panel title="Analysis rounds">
          <ModeCards />
        </Panel>
      </Box>
    </Box>
  );
}
