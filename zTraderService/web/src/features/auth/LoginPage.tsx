import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { authApi } from '../../api/auth';
import { qk } from '../../api/queryKeys';
import { AuthScreen } from './AuthScreen';
import { loginError } from './loginError';
import { normalizeUsername } from './password';
import { adoptSession } from './session';

const route = getRouteApi('/login');

export function LoginPage() {
  const { redirect } = route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: authApi.login,
    onSuccess: async (session) => {
      qc.setQueryData(qk.auth.me, adoptSession(session));
      setPassword('');
      if (session.user.mustChangePassword)
        await navigate({ to: '/change-password' });
      else await navigate({ href: redirect ?? '/' });
    },
  });

  return (
    <AuthScreen title="Trading terminal · sign in">
      <Box
        component="form"
        aria-labelledby="login-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (!username.trim() || !password) return;
          login.mutate({ username: normalizeUsername(username), password });
        }}
        sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <Box component="h1" id="login-title" sx={{ m: 0, fontSize: 20 }}>
          Sign in
        </Box>
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          autoFocus
          fullWidth
          slotProps={{
            input: { sx: { fontSize: 16, '& input': { py: 2.5 } } },
            htmlInput: { autoCapitalize: 'none', spellCheck: false },
          }}
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          fullWidth
          slotProps={{
            input: { sx: { fontSize: 16, '& input': { py: 2.5 } } },
          }}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        {login.isError ? (
          <Alert severity="error" variant="outlined" role="alert">
            {loginError(login.error)}
          </Alert>
        ) : null}
        <Button
          type="submit"
          variant="contained"
          size="large"
          fullWidth
          sx={{ py: 2, fontSize: 14 }}
          disabled={login.isPending || !username.trim() || !password}
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </Box>
    </AuthScreen>
  );
}
