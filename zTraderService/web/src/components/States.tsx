import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { describeError } from '../api/client';

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{ p: 4, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}
    >
      {children}
    </Box>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <Box
      sx={{
        p: 4,
        display: 'flex',
        gap: 2,
        alignItems: 'center',
        justifyContent: 'center',
        color: 'text.secondary',
      }}
    >
      <CircularProgress size={14} />
      <Typography variant="caption">{label}</Typography>
    </Box>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <Box sx={{ p: 2 }}>
      <Alert
        severity="error"
        variant="outlined"
        action={
          onRetry ? (
            <Button color="inherit" onClick={onRetry}>
              Retry
            </Button>
          ) : undefined
        }
      >
        {describeError(error)}
      </Alert>
    </Box>
  );
}
