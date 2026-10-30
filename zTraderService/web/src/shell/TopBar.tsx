import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { StatusDot } from '../components/StatusDot';
import { settingsQuery, statusQuery } from '../data/queries';
import { ColorModeToggle } from '../theme/ColorModeToggle';
import { capsLabel } from '../theme/theme';
import { InstrumentSelect } from './InstrumentSelect';
import { NAV } from './navConfig';
import { UserMenu } from './UserMenu';
import { AI_MODE_LABEL } from '../features/ai/aiOptions';

const QUICK = ['terminal', 'chart', 'bot', 'strategy', 'trades'] as const;

/** brand row with quick links, bot instrument, account mode, feed, risk profile, AI mode, theme and user; breadcrumb below */
export function TopBar() {
  const { data: status } = useQuery(statusQuery);
  const { data: settings } = useQuery(settingsQuery);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const live = status?.accountMode === 'LIVE';
  const crumbs = breadcrumb(pathname);
  const profile = settings?.risk_profile ?? null;
  const aiMode = settings?.ai_mode_selected ?? settings?.ai_mode;

  return (
    <Box
      component="header"
      sx={{
        borderBottom: 1,
        borderColor: 'divider',
        flexShrink: 0,
        bgcolor: 'background.paper',
      }}
    >
      <Box
        sx={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 2,
        }}
      >
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {QUICK.map((id) => {
            const item = NAV.find((n) => n.id === id);
            if (!item) return null;
            const active =
              item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
            return (
              <Button
                key={id}
                component={Link}
                to={item.to}
                color={active ? 'primary' : 'inherit'}
                variant={active ? 'outlined' : 'text'}
                sx={{
                  fontSize: 10.5,
                  px: 1.5,
                  color: active ? undefined : 'text.secondary',
                }}
              >
                {item.label}
              </Button>
            );
          })}
        </Box>
        <Box sx={{ flex: 1 }} />
        <InstrumentSelect />
        <Tooltip
          title={
            live
              ? 'Real-money account — every order is live'
              : 'Practice account'
          }
        >
          <Chip
            label={status?.accountMode ?? '…'}
            color={live ? 'error' : 'default'}
            variant={live ? 'filled' : 'outlined'}
            sx={{
              ...capsLabel,
              fontWeight: 800,
              minWidth: 56,
              ...(live
                ? {
                    animation: 'ztLive 2s ease-in-out infinite',
                    '@keyframes ztLive': { '50%': { opacity: 0.7 } },
                  }
                : {}),
            }}
          />
        </Tooltip>
        <Tooltip
          title={
            status?.ctraderAuthorized
              ? 'cTrader connected and account authorized'
              : 'cTrader not connected'
          }
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              fontSize: 10.5,
              ...capsLabel,
              color: 'text.secondary',
            }}
          >
            <StatusDot
              state={
                status ? (status.ctraderAuthorized ? 'ok' : 'error') : 'off'
              }
              pulse={!!status?.ctraderAuthorized}
            />
            {status?.ctraderAuthorized ? 'Live feed' : 'Offline'}
          </Box>
        </Tooltip>
        {profile ? (
          <Tooltip
            title={
              profile.modified
                ? `Changed since applied: ${profile.changed.join(', ')}`
                : 'Active risk profile'
            }
          >
            <Chip
              component={Link}
              to="/settings"
              clickable
              variant="outlined"
              label={`Risk: ${profile.name}${profile.modified ? ' *' : ''}`}
            />
          </Tooltip>
        ) : null}
        {aiMode ? (
          <Tooltip
            title={
              settings?.ai_mode !== aiMode
                ? `Selected ${AI_MODE_LABEL[aiMode] ?? aiMode}, running as TA only (API key missing)`
                : 'Decision mode'
            }
          >
            <Chip
              component={Link}
              to="/settings"
              clickable
              variant="outlined"
              color={aiMode === 'off' ? 'default' : 'info'}
              label={AI_MODE_LABEL[aiMode] ?? aiMode}
            />
          </Tooltip>
        ) : null}
        <ColorModeToggle />
        <UserMenu />
      </Box>
      <Box
        sx={{
          height: 20,
          display: 'flex',
          alignItems: 'center',
          px: 3,
          gap: 1,
          ...capsLabel,
          fontSize: 9.5,
          color: 'text.secondary',
          borderTop: 1,
          borderColor: 'divider',
        }}
        aria-label="Breadcrumb"
      >
        {crumbs.map((c, i) => (
          <Box
            key={c}
            component="span"
            sx={{ color: i === crumbs.length - 1 ? 'text.primary' : undefined }}
          >
            {i ? (
              <Box component="span" sx={{ mx: 1, color: 'text.disabled' }}>
                ›
              </Box>
            ) : null}
            {c}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function breadcrumb(pathname: string): string[] {
  if (pathname === '/') return ['Home', 'Terminal'];
  const hit = [...NAV]
    .sort((a, b) => b.to.length - a.to.length)
    .find((n) => n.to !== '/' && pathname.startsWith(n.to));
  const rest = hit
    ? pathname.slice(hit.to.length).split('/').filter(Boolean)
    : pathname.split('/').filter(Boolean);
  return ['Home', ...(hit ? [hit.label] : []), ...rest.map(decodeURIComponent)];
}
