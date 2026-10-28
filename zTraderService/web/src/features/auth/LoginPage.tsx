import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState, type SubmitEvent } from 'react';
import { ApiError, describeError } from '../../api/client';
import { authApi } from '../../api/auth';
import { qk } from '../../api/queryKeys';
import { normalizeUsername } from './password';
import { adoptSession } from './session';

const route = getRouteApi('/login');

function loginError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) {
      const min = e.retryAfterSec ? Math.ceil(e.retryAfterSec / 60) : 15;
      return `ใส่รหัสผิดหลายครั้งเกินไป — ลองใหม่ในอีก ${min} นาที`;
    }
    if (e.status === 401) return 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
  }
  return describeError(e) || 'เข้าสู่ระบบไม่สำเร็จ';
}

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

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    login.mutate({ username: normalizeUsername(username), password });
  };

  return (
    <div className="auth-screen">
      <form
        className="auth-box"
        onSubmit={submit}
        aria-labelledby="login-title"
      >
        <h2 id="login-title">🔒 zTrader Dashboard</h2>
        <input
          name="username"
          autoComplete="username"
          placeholder="ชื่อผู้ใช้"
          aria-label="ชื่อผู้ใช้"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="รหัสผ่าน"
          aria-label="รหัสผ่าน"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <div className="row">
          <button type="submit" className="btn-run" disabled={login.isPending}>
            เข้าสู่ระบบ
          </button>
        </div>
        <div className="form-msg error" role="alert">
          {login.isError ? '❌ ' + loginError(login.error) : null}
        </div>
      </form>
    </div>
  );
}
