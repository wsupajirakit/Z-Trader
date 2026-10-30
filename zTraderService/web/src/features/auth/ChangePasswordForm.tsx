import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { authApi } from '../../api/auth';
import { ApiError, describeError } from '../../api/client';
import { PASSWORD_MAX, PASSWORD_MIN, validateNewPassword } from './password';

/** current + new + repeat; checks the rule locally, the server stays the authority */
export function ChangePasswordForm({
  username,
  onDone,
}: {
  username: string;
  onDone: () => void | Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: authApi.changePassword,
    onSuccess: async () => {
      setCurrent('');
      setNext('');
      setAgain('');
      await onDone();
    },
  });
  const serverError =
    change.error instanceof ApiError && change.error.status === 401
      ? 'Current password is wrong'
      : change.error
        ? describeError(change.error)
        : null;
  const message = problem ?? serverError;

  return (
    <Box
      component="form"
      aria-label="Change password"
      onSubmit={(e) => {
        e.preventDefault();
        const invalid =
          validateNewPassword(next, username) ??
          (next !== again ? 'The new passwords do not match' : null) ??
          (next === current
            ? 'The new password must differ from the current one'
            : null);
        setProblem(invalid);
        if (!invalid)
          change.mutate({ currentPassword: current, newPassword: next });
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, maxWidth: 380 }}
    >
      <TextField
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => {
          setCurrent(e.target.value);
        }}
      />
      <TextField
        label={`New password (${PASSWORD_MIN}–${PASSWORD_MAX} characters, not containing the username)`}
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => {
          setNext(e.target.value);
        }}
      />
      <TextField
        label="Repeat new password"
        type="password"
        autoComplete="new-password"
        value={again}
        onChange={(e) => {
          setAgain(e.target.value);
        }}
      />
      {message ? (
        <Alert severity="error" variant="outlined" role="alert">
          {message}
        </Alert>
      ) : null}
      {change.isSuccess ? (
        <Alert severity="success" variant="outlined">
          Password changed. Other sessions were signed out.
        </Alert>
      ) : null}
      <Box>
        <Button
          type="submit"
          variant="contained"
          disabled={change.isPending || !current || !next || !again}
        >
          Change password
        </Button>
      </Box>
    </Box>
  );
}
