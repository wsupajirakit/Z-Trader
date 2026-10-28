import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { ApiError, describeError } from '../../api/client';
import { qk } from '../../api/queryKeys';
import type { Role } from '../../api/types';
import { usersApi } from '../../api/users';
import {
  normalizeUsername,
  validateNewPassword,
  validateUsername,
} from '../auth/password';
import { ROLE_LABEL, ROLES } from '../auth/roles';

const EMPTY = { username: '', name: '', role: 'viewer' as Role, password: '' };

/** New account; the user must change the initial password at first sign-in. */
export function CreateUserForm() {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: usersApi.create,
    onSuccess: async (u) => {
      setForm(EMPTY);
      setCreated(u.username);
      await qc.invalidateQueries({ queryKey: qk.users.all });
    },
  });

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreated(null);
    const username = normalizeUsername(form.username);
    const invalid =
      validateUsername(username) ??
      (form.name.trim() ? null : 'ใส่ชื่อที่แสดง') ??
      validateNewPassword(form.password, username);
    setProblem(invalid);
    if (!invalid) {
      create.mutate({
        username,
        name: form.name.trim(),
        role: form.role,
        password: form.password,
      });
    }
  };

  const serverError =
    create.error instanceof ApiError && create.error.status === 409
      ? 'ชื่อผู้ใช้นี้มีอยู่แล้ว'
      : create.error
        ? describeError(create.error)
        : null;
  const message = problem ?? serverError;

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <div>
          <label htmlFor="nu-username">ชื่อผู้ใช้ (ใช้ล็อกอิน)</label>
          <input
            id="nu-username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={form.username}
            onChange={(e) => {
              setForm({ ...form, username: e.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor="nu-name">ชื่อที่แสดง</label>
          <input
            id="nu-name"
            value={form.name}
            onChange={(e) => {
              setForm({ ...form, name: e.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor="nu-role">สิทธิ์</label>
          <select
            id="nu-role"
            value={form.role}
            onChange={(e) => {
              setForm({ ...form, role: e.target.value as Role });
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
          <label htmlFor="nu-password">รหัสผ่านเริ่มต้น (12–128 ตัว)</label>
          <input
            id="nu-password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => {
              setForm({ ...form, password: e.target.value });
            }}
          />
        </div>
        <div>
          <button
            type="submit"
            className="btn-save"
            disabled={create.isPending}
          >
            ➕ สร้างผู้ใช้
          </button>
        </div>
      </div>
      <div
        className={'form-msg' + (message ? ' error' : created ? ' ok' : '')}
        role="status"
      >
        {message
          ? '❌ ' + message
          : created
            ? `✅ สร้าง ${created} แล้ว — ผู้ใช้ต้องเปลี่ยนรหัสผ่านตอนเข้าครั้งแรก`
            : null}
      </div>
    </form>
  );
}
