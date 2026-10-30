import Add from '@mui/icons-material/Add';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { qk } from '../../api/queryKeys';
import type { Role, User } from '../../api/types';
import { usersApi } from '../../api/users';
import { DataTable, type Column } from '../../components/DataTable';
import { useDialogs } from '../../components/dialogs/context';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Panel } from '../../components/Panel';
import { ErrorState, LoadingState } from '../../components/States';
import { useAction } from '../../data/useAction';
import { dateTime } from '../../lib/format';
import {
  normalizeUsername,
  validateNewPassword,
  validateUsername,
} from '../auth/password';
import { ROLE_LABEL, ROLES } from '../auth/roles';
import { useCurrentUser } from '../auth/session';
import { usersQuery } from './usersQuery';

const ROLE_COLOR: Record<Role, 'default' | 'info' | 'primary'> = {
  viewer: 'default',
  operator: 'info',
  admin: 'primary',
};

function CreateUserDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useAction({
    fn: () =>
      usersApi.create({
        username: normalizeUsername(username),
        name: name.trim(),
        role,
        password,
      }),
    invalidate: [qk.users.all],
    success: (u) =>
      `User created: ${u.username} (${u.role}) — they must change the password at first sign-in`,
    failure: (m) => `Could not create the user: ${m}`,
    onSuccess: () => {
      setUsername('');
      setName('');
      setPassword('');
      onClose();
    },
  });
  const taken = create.error instanceof ApiError && create.error.status === 409;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <Box
        component="form"
        onSubmit={(e) => {
          e.preventDefault();
          const p =
            validateUsername(username) ??
            (name.trim() ? null : 'Enter a display name') ??
            validateNewPassword(password, username);
          setProblem(p);
          if (!p) create.mutate(undefined);
        }}
      >
        <DialogTitle>New user</DialogTitle>
        <DialogContent
          sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}
        >
          <TextField
            autoFocus
            label="Username"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            slotProps={{
              htmlInput: { autoCapitalize: 'none', spellCheck: false },
            }}
          />
          <TextField
            label="Display name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            slotProps={{ htmlInput: { maxLength: 80 } }}
          />
          <TextField
            select
            label="Role"
            value={role}
            onChange={(e) => {
              setRole(e.target.value as Role);
            }}
          >
            {ROLES.map((r) => (
              <MenuItem key={r} value={r}>
                {ROLE_LABEL[r]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Initial password (9–128)"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
          {problem || taken ? (
            <Box sx={{ color: 'terminal.down', fontSize: 12 }} role="alert">
              {problem ?? 'This username is already taken'}
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={create.isPending}>
            Create user
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

/** admin: users, roles, disable/enable, password reset (the user must change it at next sign-in) */
export function UsersPage() {
  const q = useQuery(usersQuery);
  const me = useCurrentUser();
  const dialogs = useDialogs();
  const [creating, setCreating] = useState(false);
  const update = useAction({
    fn: (v: {
      user: User;
      body: { name?: string; role?: Role; disabled?: boolean };
    }) => usersApi.update(v.user.id, v.body),
    invalidate: [qk.users.all],
    success: (u, v) =>
      v.body.disabled !== undefined
        ? `${u.username} ${u.disabled ? 'disabled' : 'enabled'}`
        : `${u.username} updated`,
    failure: (m) => `Could not update the user: ${m}`,
  });
  const reset = useAction({
    fn: (v: { user: User; password: string }) =>
      usersApi.resetPassword(v.user.id, v.password),
    invalidate: [qk.users.all],
    success: (_r, v) =>
      `Password reset for ${v.user.username} — their sessions were signed out`,
    failure: (m) => `Could not reset the password: ${m}`,
  });

  const columns = useMemo<Column<User>[]>(
    () => [
      {
        id: 'username',
        header: 'Username',
        cell: (u) => <b className="num">{u.username}</b>,
        sortValue: (u) => u.username,
      },
      {
        id: 'name',
        header: 'Name',
        cell: (u) => u.name,
        sortValue: (u) => u.name,
      },
      {
        id: 'role',
        header: 'Role',
        cell: (u) =>
          u.id === me?.id ? (
            <Chip color={ROLE_COLOR[u.role]} label={u.role} />
          ) : (
            <TextField
              select
              size="small"
              value={u.role}
              disabled={update.isPending}
              onChange={(e) => {
                update.mutate({
                  user: u,
                  body: { role: e.target.value as Role },
                });
              }}
              sx={{ minWidth: 120 }}
              slotProps={{
                htmlInput: { 'aria-label': `Role of ${u.username}` },
              }}
            >
              {ROLES.map((r) => (
                <MenuItem key={r} value={r}>
                  {r}
                </MenuItem>
              ))}
            </TextField>
          ),
        sortValue: (u) => u.role,
      },
      {
        id: 'state',
        header: 'State',
        cell: (u) =>
          u.disabled ? (
            <Chip color="error" variant="outlined" label="disabled" />
          ) : u.mustChangePassword ? (
            <Chip
              color="warning"
              variant="outlined"
              label="must change password"
            />
          ) : (
            <Chip color="success" variant="outlined" label="active" />
          ),
      },
      {
        id: 'last',
        header: 'Last sign-in',
        muted: true,
        cell: (u) => dateTime(u.lastLoginAt),
        sortValue: (u) => u.lastLoginAt ?? '',
      },
      {
        id: 'act',
        header: '',
        align: 'right',
        cell: (u) =>
          u.id === me?.id ? (
            <Box sx={{ color: 'text.secondary', fontSize: 11 }}>you</Box>
          ) : (
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button
                size="small"
                color="inherit"
                onClick={async () => {
                  const name = await dialogs.prompt({
                    title: `Rename ${u.username}`,
                    label: 'Display name',
                    defaultValue: u.name,
                    required: true,
                    maxLength: 80,
                  });
                  if (name && name.trim() !== u.name)
                    update.mutate({ user: u, body: { name: name.trim() } });
                }}
              >
                Rename
              </Button>
              <Button
                size="small"
                color="inherit"
                onClick={async () => {
                  const pw = await dialogs.prompt({
                    title: `Reset password of ${u.username}`,
                    label: 'New temporary password (9–128)',
                    required: true,
                    maxLength: 128,
                  });
                  if (pw === null) return;
                  const problem = validateNewPassword(pw, u.username);
                  if (problem) {
                    await dialogs.alert('Password not accepted', problem);
                    return;
                  }
                  const ok = await dialogs.confirm({
                    title: 'Reset password',
                    message: `${u.username} will be signed out everywhere and must change this password at the next sign-in.`,
                    confirmLabel: 'Reset password',
                    tone: 'danger',
                  });
                  if (ok) reset.mutate({ user: u, password: pw });
                }}
              >
                Reset password
              </Button>
              <Button
                size="small"
                color={u.disabled ? 'success' : 'error'}
                onClick={async () => {
                  const ok = await dialogs.confirm({
                    title: u.disabled ? 'Enable user' : 'Disable user',
                    message: u.disabled
                      ? `Allow ${u.username} to sign in again?`
                      : `${u.username} will be signed out everywhere and cannot sign in.`,
                    confirmLabel: u.disabled ? 'Enable' : 'Disable',
                    tone: u.disabled ? 'primary' : 'danger',
                  });
                  if (ok)
                    update.mutate({ user: u, body: { disabled: !u.disabled } });
                }}
              >
                {u.disabled ? 'Enable' : 'Disable'}
              </Button>
            </Box>
          ),
      },
    ],
    [dialogs, me?.id, reset, update],
  );

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="viewer reads · operator trades and changes settings · admin manages users and audit"
        actions={
          <Button
            startIcon={<Add />}
            variant="contained"
            onClick={() => {
              setCreating(true);
            }}
          >
            New user
          </Button>
        }
      />
      <PageBody>
        <Panel title="All users" dense>
          {q.isPending ? (
            <LoadingState />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <DataTable
              columns={columns}
              data={q.data}
              getRowId={(u) => u.id}
              caption="Users"
            />
          )}
        </Panel>
      </PageBody>
      <CreateUserDialog
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </>
  );
}
