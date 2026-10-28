import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { qk } from '../../api/queryKeys';
import { ChangePasswordForm } from './ChangePasswordForm';
import { useSession } from './session';
import { useLogout } from './useLogout';

const route = getRouteApi('/change-password');

/**
 * Forced after an account is created or its password reset (`mustChangePassword`): the rest of
 * the app is unreachable until this succeeds. Otherwise a voluntary change.
 */
export function ChangePasswordPage() {
  const { session: initial } = route.useRouteContext();
  const session = useSession() ?? initial;
  const forced = session.user.mustChangePassword;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useLogout();

  return (
    <div className="auth-screen">
      <div className="auth-box">
        <h2>🔑 เปลี่ยนรหัสผ่าน</h2>
        {forced ? (
          <p className="muted mb10">
            บัญชี <b className="c-txt">{session.user.username}</b>{' '}
            ต้องตั้งรหัสผ่านใหม่ก่อนเข้าใช้งาน
            (บัญชีเพิ่งสร้างหรือถูกรีเซ็ตรหัส)
          </p>
        ) : null}
        <ChangePasswordForm
          username={session.user.username}
          onDone={async () => {
            await qc.invalidateQueries({ queryKey: qk.auth.me });
            await navigate({ to: '/' });
          }}
        />
        <div className="row">
          {forced ? (
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                logout.mutate();
              }}
            >
              ออกจากระบบ
            </button>
          ) : (
            <Link to="/" className="muted">
              ← กลับหน้า dashboard
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
