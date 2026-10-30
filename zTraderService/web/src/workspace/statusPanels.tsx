import Box from '@mui/material/Box';
import { useQuery } from '@tanstack/react-query';
import { Stat } from '../components/Panel';
import { RouterMuiLink } from '../components/RouterMuiLink';
import { StatusDot } from '../components/StatusDot';
import { EmptyState } from '../components/States';
import {
  accountQuery,
  sidebarArchiveQuery,
  statusQuery,
} from '../data/queries';
import { archiveParams } from '../features/archive/archiveSearch';
import { outcomeTone } from '../features/bot/decision';
import { fmtHM, timeOf, usd } from '../lib/format';

/** feed health: cTrader, markets, account, loop */
export function SystemHealth() {
  const { data: status } = useQuery(statusQuery);
  const { data: account } = useQuery(accountQuery);
  if (!status) return null;
  const markets = Object.keys(status.markets).length
    ? status.markets
    : { [status.instrument.key]: status.market };
  return (
    <Box>
      <Stat
        label={
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <StatusDot state={status.ctraderAuthorized ? 'ok' : 'error'} />
            cTrader
          </Box>
        }
        value={status.ctraderAuthorized ? 'connected' : 'offline'}
        tone={status.ctraderAuthorized ? 'up' : 'down'}
      />
      <Stat
        label="Account"
        value={`${status.accountMode}${account?.accountId ? ` · ${account.accountId}` : ''}`}
      />
      <Stat
        label="Balance"
        value={account?.balance != null ? usd(account.balance) : '—'}
      />
      <Stat
        label="Engine"
        value={status.engine === 'ai' ? 'Claude (AI only)' : 'TA'}
      />
      {Object.entries(markets).map(([k, m]) => (
        <Stat
          key={k}
          label={`${k} market`}
          value={
            m.open
              ? `open · ${fmtHM(m.minutes_to_close)} left`
              : `${m.phase === 'weekend' ? 'weekend' : 'break'} · ${fmtHM(m.minutes_to_open)}`
          }
          tone={m.open ? 'up' : 'warn'}
        />
      ))}
      {Object.entries(status.prices).map(([k, p]) => (
        <Stat
          key={`p${k}`}
          label={`${k} tick age`}
          value={p ? `${p.age_sec}s` : 'no tick'}
          tone={!p || p.age_sec > 60 ? 'warn' : 'muted'}
        />
      ))}
    </Box>
  );
}

const TONE = {
  ok: 'terminal.up',
  err: 'terminal.down',
  wait: 'warning.main',
  no: 'text.secondary',
} as const;

export function RecentArchive() {
  const { data } = useQuery(sidebarArchiveQuery);
  if (!data?.length) return <EmptyState>No rounds archived yet</EmptyState>;
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {data.map((e) => (
        <Box
          component="li"
          key={e.file}
          sx={{
            display: 'flex',
            gap: 2,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
            fontSize: 11.5,
          }}
        >
          <Box className="num" sx={{ color: 'text.secondary' }}>
            {timeOf(e.mtime)}
          </Box>
          <RouterMuiLink
            to="/archive/$mode/$file"
            params={archiveParams(e.file)}
            underline="hover"
            sx={{ minWidth: 60 }}
          >
            {e.mode}
          </RouterMuiLink>
          <Box
            sx={{
              color: TONE[outcomeTone(e.outcome)],
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {e.outcome}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
