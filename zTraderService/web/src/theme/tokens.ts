/**
 * Colour tokens of the two schemes, after OpenTerminalUI's "terminal-noir" / "light-desk"
 * (frontend/src/theme/terminal.ts, MIT) with a blue accent instead of its orange.
 */
export interface SchemeTokens {
  bg: string;
  bgAlt: string;
  panel: string;
  panelAlt: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  accent: string;
  accentHover: string;
  focus: string;
  info: string;
  cyan: string;
  warn: string;
  up: string;
  down: string;
  candleUp: string;
  candleDown: string;
}

export const DARK: SchemeTokens = {
  bg: '#0D1117',
  bgAlt: '#0F141B',
  panel: '#161B22',
  panelAlt: '#1A212B',
  border: '#212A36',
  borderStrong: '#2D3745',
  text: '#d7dde7',
  muted: '#7f8b9d',
  accent: '#3B9EFF',
  accentHover: '#6DB6FF',
  focus: '#7cc0ff',
  info: '#a78bfa',
  cyan: '#4dd0e1',
  warn: '#ffb74d',
  up: '#00c176',
  down: '#ff4d4f',
  candleUp: '#26a69a',
  candleDown: '#ef5350',
};

export const LIGHT: SchemeTokens = {
  bg: '#eef1f5',
  bgAlt: '#e6eaf0',
  panel: '#ffffff',
  panelAlt: '#f6f8fb',
  border: '#d6dce5',
  borderStrong: '#c3ccd8',
  text: '#18202c',
  muted: '#5b6879',
  accent: '#1565D8',
  accentHover: '#0F4FB0',
  focus: '#2f80ed',
  info: '#7c3aed',
  cyan: '#0e8fa3',
  warn: '#b26a00',
  up: '#00875a',
  down: '#d92d20',
  candleUp: '#089981',
  candleDown: '#f23645',
};

export const FONT_UI =
  '"Inter", "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", "Fira Code", "IBM Plex Mono", ui-monospace, monospace';
