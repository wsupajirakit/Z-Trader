import RestartAlt from '@mui/icons-material/RestartAlt';
import ViewSidebarOutlined from '@mui/icons-material/ViewSidebarOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import { useDialogs } from '../components/dialogs/context';
import {
  terminalStore,
  useTerminalPrefs,
  type WorkspaceId,
} from '../shell/terminalStore';
import { Launchpad } from '../workspace/Launchpad';
import { WORKSPACE_LABEL } from '../workspace/layouts';

/** Terminal home: workspace bar (Trader / AI / Risk / Ops) above the Launchpad */
export function TerminalPage() {
  const prefs = useTerminalPrefs();
  const dialogs = useDialogs();
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 2,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          flexShrink: 0,
        }}
      >
        <Tabs
          value={prefs.workspace}
          onChange={(_e, v: WorkspaceId) => {
            terminalStore.set({ workspace: v });
          }}
          aria-label="Workspace"
        >
          {(Object.keys(WORKSPACE_LABEL) as WorkspaceId[]).map((w) => (
            <Tab key={w} value={w} label={WORKSPACE_LABEL[w]} />
          ))}
        </Tabs>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Restore the default layout of this workspace">
          <Button
            size="small"
            color="inherit"
            startIcon={<RestartAlt fontSize="small" />}
            onClick={async () => {
              const ok = await dialogs.confirm({
                title: 'Reset layout',
                message: `Restore the default ${WORKSPACE_LABEL[prefs.workspace]} layout?`,
                confirmLabel: 'Reset',
              });
              if (ok)
                terminalStore.set((p) => ({
                  layouts: { ...p.layouts, [p.workspace]: [] },
                }));
            }}
          >
            Reset layout
          </Button>
        </Tooltip>
        <Tooltip title="Show or hide the context rail (Ctrl+B)">
          <Button
            size="small"
            color={prefs.contextRail ? 'primary' : 'inherit'}
            startIcon={<ViewSidebarOutlined fontSize="small" />}
            onClick={() => {
              terminalStore.set((p) => ({ contextRail: !p.contextRail }));
            }}
          >
            Context rail
          </Button>
        </Tooltip>
      </Box>
      <Launchpad />
    </Box>
  );
}
