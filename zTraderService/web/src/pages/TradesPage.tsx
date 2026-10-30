import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { HistoryView } from '../features/history/HistoryView';
import { PositionsTable } from '../features/positions/PositionsTable';

export function TradesPage() {
  const [tab, setTab] = useState<'positions' | 'history'>('positions');
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <PageHeader title="Trades" />
      <Box
        sx={{
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Tabs
          value={tab}
          onChange={(_e, v: 'positions' | 'history') => {
            setTab(v);
          }}
          aria-label="Trades"
        >
          <Tab value="positions" label="Open positions" />
          <Tab value="history" label="History (30 days)" />
        </Tabs>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, p: 2 }}>
        {tab === 'positions' ? (
          <Panel title="Open positions" dense>
            <PositionsTable />
          </Panel>
        ) : (
          <Panel title="Closed trades">
            <HistoryView />
          </Panel>
        )}
      </Box>
    </Box>
  );
}
