import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { authApi } from '../../api/auth';
import { describeError } from '../../api/client';
import { qk } from '../../api/queryKeys';
import type { SessionInfo } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { dialogs } from '../../lib/dialogs';
import { dateTimeTh } from '../../lib/time';
import { ChangePasswordForm } from '../auth/ChangePasswordForm';
import { ROLE_LABEL } from '../auth/roles';
import { useCurrentUser } from '../auth/session';
import { useLogout } from '../auth/useLogout';
import { sessionsQuery } from './sessionsQuery';

/** บัญชีของฉัน — profile, signed-in devices (revoke one / all others), change password. */
export function AccountPage() {
  const user = useCurrentUser();
  const qc = useQueryClient();
  const logout = useLogout();
  const sessions = useQuery(sessionsQuery);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.auth.sessions });
  const {
    mutate: revokeSession,
    isPending: revoking,
    error: revokeError,
  } = useMutation({
    mutationFn: (s: SessionInfo) => authApi.revokeSession(s.id),
    onSuccess: async (_, s) => {
      // Revoking this very session is a sign-out.
      if (s.current) logout.mutate();
      else await refresh();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: authApi.revokeOtherSessions,
    onSuccess: refresh,
  });

  const columns = useMemo(
    (): Column<SessionInfo>[] => [
      {
        id: 'device',
        header: 'อุปกรณ์',
        cell: (s) => (
          <>
            {s.current ? <span className="tag ok">เครื่องนี้</span> : null}{' '}
            <span className="ua">{s.userAgent || '—'}</span>
          </>
        ),
      },
      { id: 'ip', header: 'IP', cell: (s) => s.ip },
      {
        id: 'created',
        header: 'เข้าสู่ระบบเมื่อ',
        cell: (s) => dateTimeTh(s.createdAt),
      },
      {
        id: 'seen',
        header: 'ใช้งานล่าสุด',
        cell: (s) => dateTimeTh(s.lastSeenAt),
      },
      {
        id: 'expires',
        header: 'หมดอายุ',
        cell: (s) => dateTimeTh(s.expiresAt),
        className: 'muted',
      },
      {
        id: 'actions',
        header: '',
        cell: (s) => (
          <button
            type="button"
            className="btn-sm btn-danger"
            disabled={revoking}
            onClick={() => {
              const q = s.current
                ? 'ยกเลิกเซสชันนี้ = ออกจากระบบทันที ยืนยัน?'
                : 'ยกเลิกเซสชันนี้? อุปกรณ์นั้นจะถูกออกจากระบบ';
              if (dialogs.confirm(q)) revokeSession(s);
            }}
          >
            ยกเลิก
          </button>
        ),
      },
    ],
    [revokeSession, revoking],
  );

  if (!user) return null;
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;
  const actionError = revokeError ?? revokeOthers.error;

  return (
    <main className="page">
      <div className="card">
        <h2>บัญชีของฉัน</h2>
        <p>
          <b>{user.name}</b> <span className="muted">({user.username})</span> ·{' '}
          <span className="muted">{ROLE_LABEL[user.role]}</span>
        </p>
        <p className="muted mt6">
          เข้าสู่ระบบล่าสุด {dateTimeTh(user.lastLoginAt)} · สร้างบัญชีเมื่อ{' '}
          {dateTimeTh(user.createdAt)}
        </p>
      </div>

      <div className="card">
        <h2>อุปกรณ์ที่ล็อกอินอยู่</h2>
        <p className="muted mb10">
          เซสชันหมดอายุเองเมื่อครบ 12 ชม. หลังล็อกอิน หรือไม่ได้ใช้งาน 2 ชม.
        </p>
        <div className="toolbar">
          <button
            type="button"
            className="btn-sm btn-danger"
            disabled={revokeOthers.isPending || others === 0}
            onClick={() => {
              if (
                dialogs.confirm(
                  `ออกจากระบบอุปกรณ์อื่นทั้งหมด (${others} เครื่อง)?`,
                )
              ) {
                revokeOthers.mutate();
              }
            }}
          >
            ออกจากระบบอุปกรณ์อื่นทั้งหมด
          </button>
        </div>
        {sessions.isPending ? (
          <div className="muted">กำลังโหลด…</div>
        ) : sessions.error ? (
          <div className="muted">
            โหลดไม่ได้: {describeError(sessions.error)}
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={sessions.data}
            getRowId={(s) => s.id}
          />
        )}
        {actionError ? (
          <div className="form-msg error">❌ {describeError(actionError)}</div>
        ) : null}
      </div>

      <div className="card">
        <h2>เปลี่ยนรหัสผ่าน</h2>
        <ChangePasswordForm username={user.username} onDone={refresh} />
      </div>
    </main>
  );
}
