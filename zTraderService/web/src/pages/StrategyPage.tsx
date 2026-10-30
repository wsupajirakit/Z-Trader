import Box from '@mui/material/Box';
import { PageHeader } from '../components/PageHeader';
import { StrategyView } from '../features/strategy/StrategyView';

export function StrategyPage() {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <PageHeader
        title="Strategy"
        subtitle="Legacy Sonic / Scalper loop (zTraderActor)"
      />
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <StrategyView />
      </Box>
    </Box>
  );
}
