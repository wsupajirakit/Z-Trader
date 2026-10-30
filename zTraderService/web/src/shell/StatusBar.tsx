import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { StatusDot } from '../components/StatusDot';
import { accountQuery, settingsQuery, statusQuery } from '../data/queries';
import { fmtHM, money, usd } from '../lib/format';

const CLOCKS = [
  { label: 'UTC', tz: 'UTC' },
  { label: 'LDN', tz: 'Europe/London' },
  { label: 'NY', tz: 'America/New_York' },
  { label: 'BKK', tz: 'Asia/Bangkok' },
] as const;

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(new Date());
    }, ms);
    return () => {
      clearInterval(t);
    };
  }, [ms]);
  return now;
}

/** bottom bar: clocks · market sessions and loop · connection, balance, daily P&L, AI quota */
export function StatusBar() {
  const now = useNow();
  const { data: status } = useQuery(statusQuery);
  const { data: settings } = useQuery(settingsQuery);
  const { data: account } = useQuery(accountQuery);
  const markets =
    status?.markets && Object.keys(status.markets).length
      ? status.markets
      : status
        ? { [status.instrument.key]: status.market }
        : {};
  const pnl = settings?.daily_pnl ?? null;
  const quota = settings?.ai_calls;

  return (
    <Box
      component="footer"
      sx={{
        height: 22,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        px: 2,
        gap: 3,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: 'terminal.bgAlt',
        fontSize: 10.5,
        color: 'text.secondary',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ display: 'flex', gap: 3 }} className="num">
        {CLOCKS.map((c) => (
          <span key={c.label}>
            {c.label}{' '}
            {now.toLocaleTimeString('en-GB', {
              timeZone: c.tz,
              hour: '2-digit',
              minute: '2-digit',
              second: c.label === 'UTC' ? '2-digit' : undefined,
              hour12: false,
            })}
          </span>
        ))}
      </Box>
      <Box sx={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        {Object.entries(markets).map(([k, m]) => (
          <Tooltip key={k} title={m.reason}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <StatusDot
                state={m.open ? 'ok' : m.phase === 'weekend' ? 'error' : 'warn'}
              />
              <span>
                {k}{' '}
                {m.open
                  ? `open · closes ${fmtHM(m.minutes_to_close)}`
                  : `${m.phase === 'weekend' ? 'weekend' : 'break'} · opens ${fmtHM(m.minutes_to_open)}`}
              </span>
            </Box>
          </Tooltip>
        ))}
        <Box
          sx={{
            display: 'flex',
            gap: 1,
            alignItems: 'center',
            color: status?.enabled ? 'terminal.up' : undefined,
          }}
        >
          <StatusDot
            state={status?.enabled ? 'ok' : 'off'}
            pulse={!!status?.enabled}
          />
          {status?.enabled ? `LOOP ON · ${status.modes.join('/')}` : 'LOOP OFF'}
        </Box>
      </Box>
      <Box
        sx={{ display: 'flex', gap: 3, justifyContent: 'flex-end' }}
        className="num"
      >
        <span>BAL {account?.balance != null ? usd(account.balance) : '—'}</span>
        <Box
          component="span"
          sx={{
            color:
              pnl == null
                ? undefined
                : pnl >= 0
                  ? 'terminal.up'
                  : 'terminal.down',
          }}
        >
          P&L {pnl == null ? '—' : money(pnl)}
        </Box>
        {quota ? (
          <span>
            AI {quota.used}/{quota.max || '∞'}
          </span>
        ) : null}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <StatusDot
            state={status ? (status.ctraderAuthorized ? 'ok' : 'error') : 'off'}
          />
          cTrader
        </Box>
      </Box>
    </Box>
  );
}
