import { CacheProvider } from '@emotion/react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { useMemo, type ReactNode } from 'react';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import { createEmotionCache } from './emotionCache';
import { appTheme } from './theme';

export const COLOR_MODE_STORAGE_KEY = 'zt:color-mode';

/** MUI theme with dark/light schemes (dark by default, choice remembered) and the CSP-safe style cache. */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const cache = useMemo(() => createEmotionCache(), []);
  return (
    <CacheProvider value={cache}>
      <ThemeProvider
        theme={appTheme}
        defaultMode="dark"
        modeStorageKey={COLOR_MODE_STORAGE_KEY}
        disableTransitionOnChange
      >
        <CssBaseline enableColorScheme />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}
