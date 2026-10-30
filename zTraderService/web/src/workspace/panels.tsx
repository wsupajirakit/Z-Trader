import Box from '@mui/material/Box';
import type { ReactNode } from 'react';
import { ActivityLogView } from '../features/activity/ActivityLogView';
import { AiSettings } from '../features/ai/AiSettings';
import { ExecutionControl } from '../features/bot/ExecutionControl';
import { ManualRun } from '../features/bot/ManualRun';
import { ModeCards } from '../features/bot/ModeCards';
import { ChartView } from '../features/chart/ChartView';
import { HistoryView } from '../features/history/HistoryView';
import { NewsList } from '../features/news/NewsList';
import { PositionsTable } from '../features/positions/PositionsTable';
import { DailyStopCard } from '../features/risk/DailyStopCard';
import { RiskProfiles } from '../features/risk/RiskProfiles';
import { RiskSettingsForm } from '../features/risk/RiskSettingsForm';
import { RecentArchive, SystemHealth } from './statusPanels';

export interface PanelDef {
  title: string;
  dense?: boolean;
  scroll?: boolean;
  render: () => ReactNode;
}

/** every panel the Launchpad can host */
export const PANELS: Record<string, PanelDef> = {
  chart: {
    title: 'Chart',
    dense: true,
    scroll: false,
    render: () => <ChartView />,
  },
  execution: {
    title: 'Execution control',
    render: () => (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <ExecutionControl />
        <ManualRun />
      </Box>
    ),
  },
  modes: { title: 'Analysis rounds', render: () => <ModeCards /> },
  positions: {
    title: 'Open positions',
    dense: true,
    render: () => <PositionsTable />,
  },
  activity: {
    title: 'System log',
    dense: true,
    scroll: false,
    render: () => <ActivityLogView />,
  },
  news: { title: 'News', render: () => <NewsList /> },
  history: {
    title: 'Trade history',
    render: () => <HistoryView chart={false} />,
  },
  ai: { title: 'AI decision', render: () => <AiSettings /> },
  riskToday: { title: 'Risk today', render: () => <DailyStopCard /> },
  profiles: { title: 'Risk profiles', render: () => <RiskProfiles /> },
  riskForm: { title: 'Risk limits', render: () => <RiskSettingsForm /> },
  health: { title: 'System health', render: () => <SystemHealth /> },
  archive: { title: 'Recent rounds', render: () => <RecentArchive /> },
};
