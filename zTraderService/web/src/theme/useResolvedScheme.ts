import { useColorScheme } from '@mui/material/styles';

/** the scheme in effect ('dark' until MUI has read the stored choice) */
export function useResolvedScheme(): 'dark' | 'light' {
  const { mode, systemMode } = useColorScheme();
  const m = mode === 'system' ? systemMode : mode;
  return m === 'light' ? 'light' : 'dark';
}
