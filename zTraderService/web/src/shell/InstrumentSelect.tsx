import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/dashboard';
import { qk } from '../api/queryKeys';
import { statusQuery } from '../data/queries';
import { useAction } from '../data/useAction';
import { useInstruments } from '../data/useInstruments';
import { useCan } from '../features/auth/session';

/** the bot's active instrument (server-side); operators can switch it while the loop is stopped */
export function InstrumentSelect({
  size = 'small',
  fullWidth = false,
}: {
  size?: 'small' | 'medium';
  fullWidth?: boolean;
}) {
  const { data: status } = useQuery(statusQuery);
  const { active, list, symbols } = useInstruments();
  const canOperate = useCan('operator');
  const running = !!status?.enabled;
  const change = useAction({
    fn: (symbol: string) => dashboardApi.setInstrument(symbol),
    invalidate: [qk.dashboard.all],
    success: (_r, s) => `Active instrument → ${s}`,
    failure: (m) => `Could not switch instrument: ${m}`,
  });
  const disabled = !canOperate || running || change.isPending;
  const why = !canOperate
    ? 'Operators can switch the instrument'
    : running
      ? 'Stop the loop to switch the instrument'
      : 'Instrument the bot analyses';
  return (
    <Tooltip title={why} disableHoverListener={!why}>
      <Select
        size={size}
        value={active}
        disabled={disabled}
        fullWidth={fullWidth}
        inputProps={{ 'aria-label': 'Bot instrument' }}
        onChange={(e) => {
          change.mutate(e.target.value);
        }}
        sx={{ minWidth: 150, fontWeight: 600 }}
      >
        {(list.length ? list.map((i) => i.key) : symbols).map((k) => {
          const info = list.find((i) => i.key === k);
          return (
            <MenuItem key={k} value={k}>
              {info?.emoji ? `${info.emoji} ` : ''}
              {k}
              {info?.name_th ? ` · ${info.name_th}` : ''}
            </MenuItem>
          );
        })}
      </Select>
    </Tooltip>
  );
}
