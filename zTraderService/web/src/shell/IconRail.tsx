import ChevronLeft from '@mui/icons-material/ChevronLeft';
import ChevronRight from '@mui/icons-material/ChevronRight';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import { Link, useRouterState } from '@tanstack/react-router';
import { hasRole } from '../features/auth/roles';
import { useCurrentUser } from '../features/auth/session';
import { capsLabel } from '../theme/theme';
import { NAV, SECTION_LABEL, type NavItem } from './navConfig';
import { terminalStore, useTerminalPrefs } from './terminalStore';

export const RAIL_COLLAPSED = 64;
export const RAIL_EXPANDED = 208;

function isActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** left navigation rail (collapsed: glyphs, expanded: sections with labels), like OpenTerminalUI's IconRail */
export function IconRail() {
  const { railExpanded } = useTerminalPrefs();
  const user = useCurrentUser();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const items = NAV.filter((n) => !n.role || hasRole(user?.role, n.role));
  const sections = (['trade', 'analysis', 'system'] as const).map((s) => ({
    s,
    items: items.filter((i) => i.section === s),
  }));
  const width = railExpanded ? RAIL_EXPANDED : RAIL_COLLAPSED;

  return (
    <Box
      component="nav"
      aria-label="Main"
      sx={{
        width,
        flexShrink: 0,
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'terminal.bgAlt',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 120ms',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      <Box
        sx={{
          height: 34,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Box
          sx={{
            width: 22,
            height: 22,
            bgcolor: 'primary.main',
            color: '#fff',
            fontWeight: 800,
            fontSize: 13,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 0.5,
          }}
          aria-hidden
        >
          Z
        </Box>
        {railExpanded ? (
          <Box
            component="span"
            sx={{ ...capsLabel, ml: 2, fontSize: 12, letterSpacing: '0.16em' }}
          >
            Z Trader
          </Box>
        ) : null}
      </Box>
      <Box sx={{ flex: 1, py: 1 }}>
        {sections.map(({ s, items: group }) =>
          group.length ? (
            <Box key={s} sx={{ mb: 1 }}>
              {railExpanded ? (
                <Box
                  sx={{
                    ...capsLabel,
                    fontSize: 9.5,
                    color: 'text.secondary',
                    px: 3,
                    py: 1,
                  }}
                >
                  {SECTION_LABEL[s]}
                </Box>
              ) : null}
              {group.map((item) => {
                const active = isActive(item, pathname);
                const body = (
                  <ButtonBase
                    component={Link}
                    to={item.to}
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    sx={{
                      width: '100%',
                      display: 'flex',
                      flexDirection: railExpanded ? 'row' : 'column',
                      justifyContent: railExpanded ? 'flex-start' : 'center',
                      gap: railExpanded ? 2 : 0.25,
                      px: railExpanded ? 3 : 0,
                      py: railExpanded ? 1.5 : 1.25,
                      borderLeft: 2,
                      borderColor: active ? 'primary.main' : 'transparent',
                      bgcolor: active ? 'action.selected' : 'transparent',
                      color: active ? 'primary.main' : 'text.primary',
                      '&:hover': { bgcolor: 'action.hover' },
                    }}
                  >
                    <Box
                      component="span"
                      className="num"
                      sx={{
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        minWidth: 22,
                        textAlign: 'center',
                      }}
                    >
                      {item.glyph}
                    </Box>
                    <Box
                      component="span"
                      sx={{
                        fontSize: railExpanded ? 12 : 9,
                        color: active ? 'primary.main' : 'text.secondary',
                      }}
                    >
                      {item.label}
                    </Box>
                  </ButtonBase>
                );
                return railExpanded ? (
                  <Box key={item.id}>{body}</Box>
                ) : (
                  <Tooltip
                    key={item.id}
                    title={`${item.label} · ${item.codes[0] ?? ''}`}
                    placement="right"
                  >
                    {body}
                  </Tooltip>
                );
              })}
            </Box>
          ) : null,
        )}
      </Box>
      <ButtonBase
        aria-label={railExpanded ? 'Collapse navigation' : 'Expand navigation'}
        onClick={() => {
          terminalStore.set((p) => ({ railExpanded: !p.railExpanded }));
        }}
        sx={{
          height: 32,
          borderTop: 1,
          borderColor: 'divider',
          color: 'text.secondary',
          flexShrink: 0,
        }}
      >
        {railExpanded ? (
          <ChevronLeft fontSize="small" />
        ) : (
          <ChevronRight fontSize="small" />
        )}
      </ButtonBase>
    </Box>
  );
}
