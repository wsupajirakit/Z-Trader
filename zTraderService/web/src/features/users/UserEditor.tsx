import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { describeError } from '../../api/client';
import { qk } from '../../api/queryKeys';
import type { Role, UpdateUserRequest, User } from '../../api/types';
import { usersApi } from '../../api/users';
import { dialogs } from '../../lib/dialogs';
import { validateNewPassword } from '../auth/password';
import { ROLE_LABEL, ROLES } from '../auth/roles';

/**
 * Edit one account: name / role, disable–enable, reset password. Every change revokes that
 * user's sessions server-side. An admin cannot disable or demote themselves.
 */
export function UserEditor({
  user,
  isSelf,
  onClose,
}: {
  user: User;
  isSelf: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.users.all });
  const update = useMutation({
    mutationFn: (body: UpdateUserRequest) => usersApi.update(user.id, body),
    onSuccess: async (u, body) => {
      setDone(
        body.disabled === undefined
          ? 'บันทึกแล้ว'
          : u.disabled
            ? 'ปิดบัญชีแล้ว'
            : 'เปิดบัญชีแล้ว',
      );
      await refresh();
    },
  });
  const reset = useMutation({
    mutationFn: (pw: string) => usersApi.resetPassword(user.id, pw),
    onSuccess: async () => {
      setPassword('');
      setDone('รีเซ็ตรหัสผ่านแล้ว — ผู้ใช้ต้องเปลี่ยนรหัสตอนเข้าครั้งถัดไป');
      await refresh();
    },
  });

  const saveProfile = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDone(null);
    const body: UpdateUserRequest = {};
    if (name.trim() && name.trim() !== user.name) body.name = name.trim();
    if (role !== user.role) body.role = role;
    if (!Object.keys(body).length) {
      setProblem('ไม่มีอะไรเปลี่ยน');
      return;
    }
    setProblem(null);
    update.mutate(body);
  };

  const resetPassword = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDone(null);
    const invalid = validateNewPassword(password, user.username);
    setProblem(invalid);
    if (
      !invalid &&
      dialogs.confirm(
        `รีเซ็ตรหัสผ่านของ ${user.username}? เซสชันทั้งหมดของผู้ใช้จะถูกยกเลิก`,
      )
    ) {
      reset.mutate(password);
    }
  };

  const toggleDisabled = () => {
    setDone(null);
    const q = user.disabled
      ? `เปิดบัญชี ${user.username} อีกครั้ง?`
      : `ปิดบัญชี ${user.username}? ผู้ใช้จะถูกออกจากระบบทันทีและล็อกอินไม่ได้`;
    if (dialogs.confirm(q)) update.mutate({ disabled: !user.disabled });
  };

  const error = update.error ?? reset.error;
  const message = problem ?? (error ? describeError(error) : null);

  return (
    <div className="card">
      <h2>แก้ไขผู้ใช้ · {user.username}</h2>
      <form onSubmit={saveProfile}>
        <div className="form-grid">
          <div>
            <label htmlFor="eu-name">ชื่อที่แสดง</label>
            <input
              id="eu-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <div>
            <label htmlFor="eu-role">สิทธิ์</label>
            <select
              id="eu-role"
              value={role}
              disabled={isSelf}
              title={isSelf ? 'ลดสิทธิ์ตัวเองไม่ได้' : undefined}
              onChange={(e) => {
                setRole(e.target.value as Role);
              }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button
              type="submit"
              className="btn-save"
              disabled={update.isPending}
            >
              💾 บันทึก
            </button>
          </div>
        </div>
      </form>

      <form onSubmit={resetPassword} className="mt8">
        <div className="form-grid">
          <div>
            <label htmlFor="eu-password">รหัสผ่านใหม่ (12–128 ตัว)</label>
            <input
              id="eu-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </div>
          <div>
            <button
              type="submit"
              className="btn-check"
              disabled={reset.isPending}
            >
              🔑 รีเซ็ตรหัสผ่าน
            </button>
          </div>
        </div>
      </form>

      <div className="toolbar mt8">
        {isSelf ? (
          <span className="muted">ปิดบัญชีหรือลดสิทธิ์ตัวเองไม่ได้</span>
        ) : (
          <button
            type="button"
            className={user.disabled ? 'btn-sm' : 'btn-sm btn-danger'}
            disabled={update.isPending}
            onClick={toggleDisabled}
          >
            {user.disabled ? 'เปิดบัญชี' : 'ปิดบัญชี'}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn-sm" onClick={onClose}>
          ปิด
        </button>
      </div>
      <div
        className={'form-msg' + (message ? ' error' : done ? ' ok' : '')}
        role="status"
      >
        {message ? '❌ ' + message : done ? '✅ ' + done : null}
      </div>
    </div>
  );
}
