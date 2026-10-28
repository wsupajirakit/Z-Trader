import { useMutation } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { ApiError, describeError } from '../../api/client';
import { authApi } from '../../api/auth';
import { validateNewPassword } from './password';

/**
 * Current + new password (twice). On success the server signs out every *other* session;
 * this one stays valid.
 */
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

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const invalid =
      validateNewPassword(next, username) ??
      (next !== again ? 'รหัสผ่านใหม่สองช่องไม่ตรงกัน' : null) ??
      (next === current ? 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม' : null);
    setProblem(invalid);
    if (!invalid)
      change.mutate({ currentPassword: current, newPassword: next });
  };

  const serverError =
    change.error instanceof ApiError && change.error.status === 401
      ? 'รหัสผ่านปัจจุบันไม่ถูกต้อง'
      : change.error
        ? describeError(change.error)
        : null;
  const message = problem ?? serverError;

  return (
    <form className="stack" onSubmit={submit}>
      {/* lets password managers attach the new password to the right account */}
      <input
        type="hidden"
        name="username"
        autoComplete="username"
        value={username}
      />
      <label htmlFor="pw-current">รหัสผ่านปัจจุบัน</label>
      <input
        id="pw-current"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => {
          setCurrent(e.target.value);
        }}
      />
      <label htmlFor="pw-new">
        รหัสผ่านใหม่ (12–128 ตัว และต้องไม่มีชื่อผู้ใช้)
      </label>
      <input
        id="pw-new"
        type="password"
        autoComplete="new-password"
        required
        value={next}
        onChange={(e) => {
          setNext(e.target.value);
        }}
      />
      <label htmlFor="pw-again">ยืนยันรหัสผ่านใหม่</label>
      <input
        id="pw-again"
        type="password"
        autoComplete="new-password"
        required
        value={again}
        onChange={(e) => {
          setAgain(e.target.value);
        }}
      />
      <button type="submit" className="btn-save" disabled={change.isPending}>
        เปลี่ยนรหัสผ่าน
      </button>
      <div
        className={
          'form-msg' + (message ? ' error' : change.isSuccess ? ' ok' : '')
        }
        role="status"
      >
        {message
          ? '❌ ' + message
          : change.isSuccess
            ? '✅ เปลี่ยนรหัสผ่านแล้ว — อุปกรณ์อื่นที่ล็อกอินอยู่ถูกออกจากระบบทั้งหมด'
            : null}
      </div>
    </form>
  );
}
