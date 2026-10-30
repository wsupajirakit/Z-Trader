import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { useColorScheme } from '@mui/material/styles';

/** Switches between the dark and light schemes; the choice is stored in localStorage by MUI. */
export function ColorModeToggle() {
  const { mode, systemMode, setMode } = useColorScheme();
  const current = mode === 'system' ? (systemMode ?? 'dark') : (mode ?? 'dark');
  const next = current === 'dark' ? 'light' : 'dark';
  return (
    <Tooltip title={`Switch to ${next} theme`}>
      <IconButton
        aria-label={`Switch to ${next} theme`}
        onClick={() => {
          setMode(next);
        }}
      >
        {current === 'dark' ? (
          <LightModeOutlined fontSize="small" />
        ) : (
          <DarkModeOutlined fontSize="small" />
        )}
      </IconButton>
    </Tooltip>
  );
}
