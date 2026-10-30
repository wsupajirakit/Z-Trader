import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { qk } from '../../api/queryKeys';
import { AuthScreen } from './AuthScreen';
import { ChangePasswordForm } from './ChangePasswordForm';
import { useSession } from './session';
import { useLogout } from './useLogout';

const route = getRouteApi('/change-password');

/** forced after create/reset (only option besides logging out), optional otherwise */
export function ChangePasswordPage() {
  const { session: initial } = route.useRouteContext();
  const session = useSession() ?? initial;
  const forced = session.user.mustChangePassword;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();
  return (
    <AuthScreen title="Change password">
      {forced ? (
        <Alert severity="warning" variant="outlined" sx={{ mb: 3 }}>
          Account <b>{session.user.username}</b> must set a new password before
          continuing (new account or password reset).
        </Alert>
      ) : null}
      <ChangePasswordForm
        username={session.user.username}
        onDone={async () => {
          await qc.invalidateQueries({ queryKey: qk.auth.me });
          await navigate({ to: '/' });
        }}
      />
      <Box sx={{ mt: 3 }}>
        {forced ? (
          <Button
            color="inherit"
            onClick={() => {
              logout.mutate();
            }}
          >
            Log out
          </Button>
        ) : (
          <Button color="inherit" onClick={() => void navigate({ to: '/' })}>
            ← Back to the terminal
          </Button>
        )}
      </Box>
    </AuthScreen>
  );
}
