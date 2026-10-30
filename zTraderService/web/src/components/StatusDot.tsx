import Box from '@mui/material/Box';

export type DotState = 'ok' | 'warn' | 'error' | 'off';

/** small round state indicator (feed, market session, connection) */
export function StatusDot({
  state,
  pulse = false,
}: {
  state: DotState;
  pulse?: boolean;
}) {
  const color =
    state === 'ok'
      ? 'terminal.up'
      : state === 'warn'
        ? 'warning.main'
        : state === 'error'
          ? 'terminal.down'
          : 'text.disabled';
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        bgcolor: color,
        flexShrink: 0,
        animation: pulse ? 'ztPulse 1.6s ease-in-out infinite' : undefined,
        '@keyframes ztPulse': {
          '0%,100%': { opacity: 1 },
          '50%': { opacity: 0.35 },
        },
      }}
    />
  );
}
