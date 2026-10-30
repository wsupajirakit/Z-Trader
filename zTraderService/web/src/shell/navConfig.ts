import type { Role } from '../api/types';

export interface NavItem {
  id: string;
  label: string;
  /** 2–3 letter glyph shown in the collapsed rail */
  glyph: string;
  to: string;
  /** GO-bar function code(s) */
  codes: string[];
  description: string;
  role?: Role;
  section: 'trade' | 'analysis' | 'system';
}

/** left rail and GO-bar targets, in rail order */
export const NAV: readonly NavItem[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    glyph: 'TM',
    to: '/',
    codes: ['TERM', 'HOME', 'LAUNCH'],
    description: 'Launchpad workspace with linked panels',
    section: 'trade',
  },
  {
    id: 'chart',
    label: 'Chart',
    glyph: 'CH',
    to: '/chart',
    codes: ['CH', 'GP'],
    description: 'Live price chart with selectable data source',
    section: 'trade',
  },
  {
    id: 'bot',
    label: 'Bot',
    glyph: 'BT',
    to: '/bot',
    codes: ['BOT', 'OPS', 'EXEC'],
    description: 'Execution control, AI, risk and system tabs',
    section: 'trade',
  },
  {
    id: 'strategy',
    label: 'Strategy',
    glyph: 'ST',
    to: '/strategy',
    codes: ['STRAT', 'ACTOR', 'SONIC'],
    description: 'Legacy Sonic/Scalper strategy loop (zTraderActor)',
    section: 'trade',
  },
  {
    id: 'trades',
    label: 'Trades',
    glyph: 'TR',
    to: '/trades',
    codes: ['POS', 'HIST', 'TRADES', 'PORT'],
    description: 'Open positions and closed trade history',
    section: 'analysis',
  },
  {
    id: 'archive',
    label: 'Archive',
    glyph: 'AR',
    to: '/archive',
    codes: ['ARCH', 'ARC'],
    description: 'Every analysis round the bot archived',
    section: 'analysis',
  },
  {
    id: 'news',
    label: 'News',
    glyph: 'NW',
    to: '/news',
    codes: ['NEWS', 'N'],
    description: 'Headlines filtered for the active instrument',
    section: 'analysis',
  },
  {
    id: 'settings',
    label: 'Settings',
    glyph: 'SG',
    to: '/settings',
    codes: ['SET', 'RISK', 'AI', 'PROFILE'],
    description: 'Risk profiles, AI decision settings, appearance',
    section: 'system',
  },
  {
    id: 'account',
    label: 'Account',
    glyph: 'AC',
    to: '/account',
    codes: ['ACCT', 'ME'],
    description: 'Your sessions and password',
    section: 'system',
  },
  {
    id: 'users',
    label: 'Users',
    glyph: 'US',
    to: '/admin/users',
    codes: ['USERS'],
    description: 'Manage users and roles',
    role: 'admin',
    section: 'system',
  },
  {
    id: 'audit',
    label: 'Audit',
    glyph: 'AU',
    to: '/admin/audit',
    codes: ['AUDIT', 'LOGS'],
    description: 'Audit trail of every action',
    role: 'admin',
    section: 'system',
  },
];

export const SECTION_LABEL: Record<NavItem['section'], string> = {
  trade: 'Trade',
  analysis: 'Analysis',
  system: 'System',
};
