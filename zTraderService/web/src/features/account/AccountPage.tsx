import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { authApi } from '../../api/auth';
import { qk } from '../../api/queryKeys';
import type { SessionInfo } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { useDialogs } from '../../components/dialogs/context';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Panel, Stat } from '../../components/Panel';
import { ErrorState, LoadingState } from '../../components/States';
import { useAction } from '../../data/useAction';
import { dateTime } from '../../lib/format';
import { ChangePasswordForm } from '../auth/ChangePasswordForm';
import { ROLE_LABEL } from '../auth/roles';
import { useCurrentUser } from '../auth/session';
import { useLogout } from '../auth/useLogout';
import { sessionsQuery } from './sessionsQuery';

/** my account: profile, signed-in devices (revoke one / all others), change password */
export function AccountPage() {
  const user = useCurrentUser();
  const sessions = useQuery(sessionsQuery);
  const dialogs = useDialogs();
  const logout = useLogout();
  const qc = useQueryClient();
  const revoke = useAction({
    fn: (s: SessionInfo) => authApi.revokeSession(s.id),
    invalidate: [qk.auth.sessions],
    success: (_r, s) => (s.current ? null : 'Session revoked'),
    onSuccess: (_r, s) => {
      if (s.current) logout.mutate();
    },
  });
  const revokeOthers = useAction({
    fn: () => authApi.revokeOtherSessions(),
    invalidate: [qk.auth.sessions],
    success: () => 'Signed out everywhere else',
  });
  const columns = useMemo<Column<SessionInfo>[]>(
    () => [
      {
        id: 'device',
        header: 'Device',
        cell: (s) => (
          <Box
            sx={{
              maxWidth: 360,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={s.userAgent}
          >
            {s.current ? (
              <Chip color="primary" label="this device" sx={{ mr: 1 }} />
            ) : null}
            {s.userAgent || 'unknown'}
          </Box>
        ),
      },
      {
        id: 'ip',
        header: 'IP',
        cell: (s) => <span className="num">{s.ip}</span>,
      },
      {
        id: 'created',
        header: 'Signed in',
        muted: true,
        cell: (s) => dateTime(s.createdAt),
        sortValue: (s) => s.createdAt,
      },
      {
        id: 'seen',
        header: 'Last seen',
        muted: true,
        cell: (s) => dateTime(s.lastSeenAt),
        sortValue: (s) => s.lastSeenAt,
      },
      {
        id: 'expires',
        header: 'Expires',
        muted: true,
        cell: (s) => dateTime(s.expiresAt),
      },
      {
        id: 'act',
        header: '',
        align: 'right',
        cell: (s) => (
          <Button
            size="small"
            color="error"
            disabled={revoke.isPending}
            onClick={async () => {
              const ok = await dialogs.confirm({
                title: s.current ? 'Sign out this device' : 'Revoke session',
                message: s.current
                  ? 'This is the session you are using — you will be signed out.'
                  : `Sign out the session from ${s.ip}?`,
                confirmLabel: s.current ? 'Sign out' : 'Revoke',
                tone: 'danger',
              });
              if (ok) revoke.mutate(s);
            }}
          >
            {s.current ? 'Sign out' : 'Revoke'}
          </Button>
        ),
      },
    ],
    [dialogs, revoke],
  );
  if (!user) return null;
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;

  return (
    <>
      <PageHeader
        title="My account"
        subtitle={`${user.name} · ${user.username}`}
      />
      <PageBody>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: '320px 1fr' },
            gap: 2,
          }}
        >
          <Panel title="Profile" scroll={false}>
            <Stat label="Username" value={user.username} />
            <Stat label="Name" value={user.name} />
            <Stat label="Role" value={ROLE_LABEL[user.role]} />
            <Stat label="Last sign-in" value={dateTime(user.lastLoginAt)} />
          </Panel>
          <Panel
            title="Signed-in devices"
            dense
            actions={
              <Button
                size="small"
                color="error"
                disabled={revokeOthers.isPending || others === 0}
                onClick={async () => {
                  const ok = await dialogs.confirm({
                    title: 'Sign out everywhere else',
                    message: `Revoke the other ${others} session(s)?`,
                    confirmLabel: 'Sign out others',
                    tone: 'danger',
                  });
                  if (ok) revokeOthers.mutate(undefined);
                }}
              >
                Sign out other devices
              </Button>
            }
          >
            {sessions.isPending ? (
              <LoadingState />
            ) : sessions.isError ? (
              <ErrorState
                error={sessions.error}
                onRetry={() => void sessions.refetch()}
              />
            ) : (
              <DataTable
                columns={columns}
                data={sessions.data}
                getRowId={(s) => s.id}
                caption="Sessions"
              />
            )}
          </Panel>
          <Box sx={{ gridColumn: { lg: '1 / -1' } }}>
            <Panel title="Change password" scroll={false}>
              <ChangePasswordForm
                username={user.username}
                onDone={async () => {
                  await qc.invalidateQueries({ queryKey: qk.auth.sessions });
                }}
              />
            </Panel>
          </Box>
        </Box>
      </PageBody>
    </>
  );
}
