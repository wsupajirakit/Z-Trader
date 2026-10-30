import {
  alpha,
  createTheme,
  type Components,
  type Theme,
} from '@mui/material/styles';
import { DARK, FONT_MONO, FONT_UI, LIGHT, type SchemeTokens } from './tokens';

declare module '@mui/material/styles' {
  interface Palette {
    terminal: SchemeTokens;
  }
  interface PaletteOptions {
    terminal?: SchemeTokens;
  }
}

function palette(t: SchemeTokens, mode: 'dark' | 'light') {
  return {
    mode,
    primary: { main: t.accent, dark: t.accentHover, contrastText: '#ffffff' },
    secondary: { main: t.info },
    success: { main: t.up },
    error: { main: t.down },
    warning: { main: t.warn },
    info: { main: t.info },
    background: { default: t.bg, paper: t.panel },
    text: { primary: t.text, secondary: t.muted },
    divider: t.border,
    terminal: t,
  };
}

/** label style shared by panel titles, table heads, tabs and buttons: small caps, wide tracking */
export const capsLabel = {
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 600,
} as const;

const components: Components<Omit<Theme, 'components'>> = {
  MuiCssBaseline: {
    styleOverrides: (theme) => ({
      'html, body, #root': { height: '100%' },
      body: {
        fontSize: 13,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.5,
        WebkitFontSmoothing: 'antialiased',
        overflow: 'hidden',
      },
      '*': {
        scrollbarWidth: 'thin',
        scrollbarColor: `${theme.vars?.palette.terminal.borderStrong ?? DARK.borderStrong} transparent`,
      },
      '.num, code, kbd, pre': {
        fontFamily: FONT_MONO,
        fontVariantNumeric: 'tabular-nums',
      },
      kbd: {
        fontSize: 10,
        padding: '1px 4px',
        border: `1px solid ${theme.vars?.palette.divider ?? DARK.border}`,
        borderRadius: 2,
      },
      '.react-grid-placeholder': {
        background: `${alpha(DARK.info, 0.25)} !important`,
        borderRadius: 2,
      },
    }),
  },
  MuiPaper: {
    defaultProps: { elevation: 0 },
    styleOverrides: {
      root: ({ theme }) => ({
        backgroundImage: 'none',
        borderRadius: 2,
        border: `1px solid ${theme.vars?.palette.divider ?? DARK.border}`,
      }),
    },
  },
  MuiButtonBase: { defaultProps: { disableRipple: true } },
  MuiButton: {
    defaultProps: { disableElevation: true, size: 'small' },
    styleOverrides: {
      root: {
        ...capsLabel,
        borderRadius: 2,
        fontSize: 11,
        lineHeight: 1.6,
        minWidth: 0,
      },
      sizeSmall: { padding: '3px 10px' },
      outlined: ({ theme }) => ({
        borderColor: theme.vars?.palette.terminal.borderStrong,
      }),
    },
  },
  MuiIconButton: {
    defaultProps: { size: 'small' },
    styleOverrides: { root: { borderRadius: 2 } },
  },
  MuiToggleButton: {
    styleOverrides: {
      root: { ...capsLabel, fontSize: 10, padding: '3px 8px', borderRadius: 2 },
    },
  },
  MuiTextField: { defaultProps: { size: 'small', variant: 'outlined' } },
  MuiFormControl: { defaultProps: { size: 'small' } },
  MuiSelect: { defaultProps: { size: 'small' } },
  MuiOutlinedInput: {
    styleOverrides: {
      root: ({ theme }) => ({
        borderRadius: 2,
        fontSize: 13.5,
        backgroundColor: theme.vars?.palette.terminal.bgAlt,
        '& .MuiOutlinedInput-notchedOutline': {
          borderColor: theme.vars?.palette.terminal.borderStrong,
        },
      }),
      input: { padding: '6px 8px' },
    },
  },
  MuiInputLabel: { styleOverrides: { root: { fontSize: 12 } } },
  MuiFormHelperText: {
    styleOverrides: { root: { fontSize: 11, marginLeft: 0 } },
  },
  MuiMenu: {
    styleOverrides: {
      paper: ({ theme }) => ({
        border: `1px solid ${theme.vars?.palette.terminal.borderStrong}`,
      }),
    },
  },
  MuiMenuItem: { styleOverrides: { root: { fontSize: 12, minHeight: 30 } } },
  MuiAutocomplete: {
    styleOverrides: {
      paper: ({ theme }) => ({
        border: `1px solid ${theme.vars?.palette.terminal.borderStrong}`,
        fontSize: 12,
      }),
      option: { fontSize: 12, minHeight: 30 },
    },
  },
  MuiDialog: {
    styleOverrides: {
      paper: ({ theme }) => ({
        border: `1px solid ${theme.vars?.palette.terminal.borderStrong}`,
        backgroundColor: theme.vars?.palette.terminal.panel,
      }),
    },
  },
  MuiDialogTitle: {
    styleOverrides: {
      root: ({ theme }) => ({
        ...capsLabel,
        fontSize: 12,
        color: theme.vars?.palette.primary.main,
        padding: '10px 16px',
        borderBottom: `1px solid ${theme.vars?.palette.divider}`,
      }),
    },
  },
  MuiDialogContent: {
    styleOverrides: { root: { padding: '14px 16px !important' } },
  },
  MuiDialogActions: {
    styleOverrides: {
      root: ({ theme }) => ({
        padding: '8px 16px',
        borderTop: `1px solid ${theme.vars?.palette.divider}`,
      }),
    },
  },
  MuiTabs: {
    styleOverrides: { root: { minHeight: 32 }, indicator: { height: 2 } },
  },
  MuiTab: {
    styleOverrides: {
      root: {
        ...capsLabel,
        minHeight: 32,
        fontSize: 11,
        padding: '6px 12px',
        minWidth: 0,
      },
    },
  },
  MuiTableCell: {
    defaultProps: { size: 'small' },
    styleOverrides: {
      root: ({ theme }) => ({
        fontSize: 12.5,
        padding: '5px 8px',
        borderBottom: `1px solid ${theme.vars ? `rgba(${theme.vars.palette.dividerChannel} / 0.6)` : DARK.border}`,
        fontVariantNumeric: 'tabular-nums',
      }),
      head: ({ theme }) => ({
        ...capsLabel,
        fontSize: 10,
        color: theme.vars?.palette.text.secondary,
        backgroundColor: theme.vars?.palette.terminal.panelAlt,
        whiteSpace: 'nowrap',
      }),
    },
  },
  MuiChip: {
    defaultProps: { size: 'small' },
    styleOverrides: {
      root: { borderRadius: 2, fontSize: 10.5, fontWeight: 600, height: 20 },
    },
  },
  MuiTooltip: {
    defaultProps: { arrow: true, enterDelay: 300 },
    styleOverrides: { tooltip: { fontSize: 11 } },
  },
  MuiAlert: {
    styleOverrides: {
      root: { fontSize: 12, borderRadius: 2, padding: '2px 10px' },
      message: { padding: '6px 0' },
    },
  },
  MuiSwitch: { defaultProps: { size: 'small' } },
  MuiCheckbox: { defaultProps: { size: 'small' } },
  MuiRadio: { defaultProps: { size: 'small' } },
  MuiSlider: { defaultProps: { size: 'small' } },
  MuiLinearProgress: {
    styleOverrides: { root: { borderRadius: 1, height: 4 } },
  },
  MuiSnackbar: {
    defaultProps: { anchorOrigin: { vertical: 'bottom', horizontal: 'right' } },
  },
};

export const appTheme = createTheme({
  cssVariables: { colorSchemeSelector: 'data', cssVarPrefix: 'zt' },
  colorSchemes: {
    dark: { palette: palette(DARK, 'dark') },
    light: { palette: palette(LIGHT, 'light') },
  },
  defaultColorScheme: 'dark',
  shape: { borderRadius: 2 },
  spacing: 4,
  typography: {
    fontFamily: FONT_UI,
    fontSize: 13,
    htmlFontSize: 16,
    h1: { fontSize: 20, fontWeight: 700 },
    h2: { fontSize: 16, fontWeight: 700 },
    h3: { fontSize: 14, fontWeight: 700 },
    h4: { fontSize: 13, fontWeight: 700 },
    body1: { fontSize: 13.5 },
    body2: { fontSize: 13 },
    caption: { fontSize: 12 },
    overline: {
      fontSize: 10,
      letterSpacing: '0.08em',
      fontWeight: 600,
      lineHeight: 1.6,
    },
  },
  components,
});

export const tokensFor = (
  scheme: 'dark' | 'light' | undefined,
): SchemeTokens => (scheme === 'light' ? LIGHT : DARK);
export { FONT_MONO };
