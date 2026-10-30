import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { statusQuery } from '../data/queries';
import { ActivityLogView } from '../features/activity/ActivityLogView';
import { AiSettings } from '../features/ai/AiSettings';
import { ExecutionControl } from '../features/bot/ExecutionControl';
import { ManualRun } from '../features/bot/ManualRun';
import { ModeCards } from '../features/bot/ModeCards';
import { DailyStopCard } from '../features/risk/DailyStopCard';
import { RiskProfiles } from '../features/risk/RiskProfiles';
import { RiskSettingsForm } from '../features/risk/RiskSettingsForm';
import { RecentArchive, SystemHealth } from '../workspace/statusPanels';

type BotTab = 'trader' | 'ai' | 'risk' | 'system';

/** bot operations, OpenTerminalUI Ops-dashboard style: one header, role tabs, 2-column panel grids */
export function BotPage() {
  const [tab, setTab] = useState<BotTab>('trader');
  const { data: status } = useQuery(statusQuery);
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
        title="Bot operations"
        subtitle={
          status
            ? `${status.instrument.key} · ${status.enabled ? `loop on (${status.enabled_instruments.join(', ')} · ${status.modes.join('/')})` : 'loop off'} · ${status.accountMode}`
            : undefined
        }
      />
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
          onChange={(_e, v: BotTab) => {
            setTab(v);
          }}
          aria-label="Bot sections"
        >
          <Tab value="trader" label="Trader" />
          <Tab value="ai" label="AI" />
          <Tab value="risk" label="Risk" />
          <Tab value="system" label="System" />
        </Tabs>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {tab === 'trader' ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: '400px 1fr' },
              gap: 2,
              alignItems: 'start',
            }}
          >
            <Panel title="Execution control" scroll={false}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <ExecutionControl />
                <ManualRun />
              </Box>
            </Panel>
            <Panel title="Analysis rounds" scroll={false}>
              <ModeCards />
            </Panel>
            <Box sx={{ gridColumn: { lg: '1 / -1' }, height: 320 }}>
              <Panel title="System log" dense scroll={false}>
                <ActivityLogView />
              </Panel>
            </Box>
          </Box>
        ) : null}
        {tab === 'ai' ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                lg: 'minmax(420px, 640px) 1fr',
              },
              gap: 2,
              alignItems: 'start',
            }}
          >
            <Panel title="AI decision settings" scroll={false}>
              <AiSettings />
            </Panel>
            <Panel title="Latest AI answers" scroll={false}>
              <ModeCards />
            </Panel>
          </Box>
        ) : null}
        {tab === 'risk' ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: '1fr 320px' },
              gap: 2,
              alignItems: 'start',
            }}
          >
            <Panel title="Risk profiles" scroll={false}>
              <RiskProfiles />
            </Panel>
            <Panel title="Risk today" scroll={false}>
              <DailyStopCard />
            </Panel>
            <Box sx={{ gridColumn: { lg: '1 / -1' } }}>
              <Panel title="Risk limits" scroll={false}>
                <RiskSettingsForm />
              </Panel>
            </Box>
          </Box>
        ) : null}
        {tab === 'system' ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
              gap: 2,
              alignItems: 'start',
            }}
          >
            <Panel title="Feed health" scroll={false}>
              <SystemHealth />
            </Panel>
            <Panel title="Kill switch" scroll={false}>
              <DailyStopCard />
            </Panel>
            <Panel title="Recent rounds" scroll={false}>
              <RecentArchive />
            </Panel>
            <Box sx={{ height: 360 }}>
              <Panel title="System messages" dense scroll={false}>
                <ActivityLogView />
              </Panel>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
