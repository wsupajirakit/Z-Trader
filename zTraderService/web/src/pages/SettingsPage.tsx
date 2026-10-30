import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useColorScheme } from '@mui/material/styles';
import { useState } from 'react';
import { useDialogs } from '../components/dialogs/context';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { AiSettings } from '../features/ai/AiSettings';
import { RiskProfiles } from '../features/risk/RiskProfiles';
import { RiskSettingsForm } from '../features/risk/RiskSettingsForm';
import { terminalStore, useTerminalPrefs } from '../shell/terminalStore';

type SettingsTab = 'profiles' | 'limits' | 'ai' | 'appearance';

function Appearance() {
  const { mode, setMode } = useColorScheme();
  const prefs = useTerminalPrefs();
  const dialogs = useDialogs();
  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 520 }}
    >
      <Box>
        <Box sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>Theme</Box>
        <ToggleButtonGroup
          exclusive
          value={mode ?? 'dark'}
          onChange={(_e, v: 'dark' | 'light' | 'system' | null) => {
            if (v) setMode(v);
          }}
          aria-label="Theme"
        >
          <ToggleButton value="dark">Dark</ToggleButton>
          <ToggleButton value="light">Light</ToggleButton>
          <ToggleButton value="system">System</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <FormControlLabel
        control={
          <Switch
            checked={prefs.tickerTape}
            onChange={(e) => {
              terminalStore.set({ tickerTape: e.target.checked });
            }}
          />
        }
        label="Show the quote ticker"
      />
      <FormControlLabel
        control={
          <Switch
            checked={prefs.contextRail}
            onChange={(e) => {
              terminalStore.set({ contextRail: e.target.checked });
            }}
          />
        }
        label="Show the context rail (Ctrl+B)"
      />
      <FormControlLabel
        control={
          <Switch
            checked={prefs.railExpanded}
            onChange={(e) => {
              terminalStore.set({ railExpanded: e.target.checked });
            }}
          />
        }
        label="Expanded navigation rail"
      />
      <Box>
        <Button
          color="error"
          variant="outlined"
          onClick={async () => {
            const ok = await dialogs.confirm({
              title: 'Reset terminal preferences',
              message:
                'Restore every workspace layout, chart choice and panel setting on this browser?',
              confirmLabel: 'Reset',
              tone: 'danger',
            });
            if (ok) terminalStore.reset();
          }}
        >
          Reset terminal preferences
        </Button>
      </Box>
    </Box>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('profiles');
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <PageHeader title="Settings" />
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
          onChange={(_e, v: SettingsTab) => {
            setTab(v);
          }}
          aria-label="Settings sections"
        >
          <Tab value="profiles" label="Risk profiles" />
          <Tab value="limits" label="Risk limits" />
          <Tab value="ai" label="AI decision" />
          <Tab value="appearance" label="Appearance" />
        </Tabs>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {tab === 'profiles' ? (
          <Panel title="Risk profiles" scroll={false}>
            <RiskProfiles />
          </Panel>
        ) : tab === 'limits' ? (
          <Panel title="Risk limits" scroll={false}>
            <RiskSettingsForm />
          </Panel>
        ) : tab === 'ai' ? (
          <Box sx={{ maxWidth: 760 }}>
            <Panel title="AI decision settings" scroll={false}>
              <AiSettings />
            </Panel>
          </Box>
        ) : (
          <Panel title="Appearance" scroll={false}>
            <Appearance />
          </Panel>
        )}
      </Box>
    </Box>
  );
}
