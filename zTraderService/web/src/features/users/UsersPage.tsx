import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { describeError } from '../../api/client';
import type { User } from '../../api/types';
import { DataTable, type Column } from '../../components/DataTable';
import { dateTimeTh } from '../../lib/time';
import { useCurrentUser } from '../auth/session';
import { CreateUserForm } from './CreateUserForm';
import { UserEditor } from './UserEditor';
import { usersQuery } from './usersQuery';

/** Admin: every account, create, edit role/name, disable/enable, reset password. */
export function UsersPage() {
  const me = useCurrentUser();
  const { data, error, isPending } = useQuery(usersQuery);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data?.find((u) => u.id === selectedId) ?? null;

  const columns = useMemo(
    (): Column<User>[] => [
      {
        id: 'username',
        header: 'ชื่อผู้ใช้',
        cell: (u) => (
          <>
            <b>{u.username}</b>
            {u.id === me?.id ? <span className="muted"> (คุณ)</span> : null}
          </>
        ),
      },
      { id: 'name', header: 'ชื่อ', cell: (u) => u.name },
      {
        id: 'role',
        header: 'สิทธิ์',
        cell: (u) => <span className="tag info">{u.role}</span>,
      },
      {
        id: 'state',
        header: 'สถานะ',
        cell: (u) => (
          <span className="cell-actions">
            {u.disabled ? (
              <span className="tag bad">ปิดอยู่</span>
            ) : (
              <span className="tag ok">ใช้งาน</span>
            )}
            {u.mustChangePassword ? (
              <span className="tag warn">รอเปลี่ยนรหัส</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'last',
        header: 'ล็อกอินล่าสุด',
        cell: (u) => dateTimeTh(u.lastLoginAt),
        className: 'muted',
      },
      {
        id: 'created',
        header: 'สร้างเมื่อ',
        cell: (u) => dateTimeTh(u.createdAt),
        className: 'muted',
      },
      {
        id: 'edit',
        header: '',
        cell: (u) => (
          <button
            type="button"
            className="btn-sm"
            onClick={() => {
              setSelectedId(u.id);
            }}
          >
            แก้ไข
          </button>
        ),
      },
    ],
    [me?.id],
  );

  return (
    <main className="page">
      <div className="card">
        <h2>ผู้ใช้ทั้งหมด</h2>
        {isPending ? (
          <div className="muted">กำลังโหลด…</div>
        ) : error ? (
          <div className="muted">โหลดไม่ได้: {describeError(error)}</div>
        ) : (
          <DataTable columns={columns} data={data} getRowId={(u) => u.id} />
        )}
      </div>
      {selected ? (
        <UserEditor
          key={selected.id}
          user={selected}
          isSelf={selected.id === me?.id}
          onClose={() => {
            setSelectedId(null);
          }}
        />
      ) : null}
      <div className="card">
        <h2>เพิ่มผู้ใช้</h2>
        <CreateUserForm />
      </div>
    </main>
  );
}
