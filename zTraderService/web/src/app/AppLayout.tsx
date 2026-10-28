import { Link, Outlet } from '@tanstack/react-router';
import { Can } from '../features/auth/Can';
import { useCurrentUser } from '../features/auth/session';
import { useLogout } from '../features/auth/useLogout';
import { ActivityLogProvider } from '../features/dashboard/activity/ActivityLogProvider';
import { StatusHeader } from '../features/dashboard/header/StatusHeader';
import { InfoProvider } from '../features/dashboard/info/InfoProvider';

/** Signed-in shell: status header, page navigation, the current page. */
export function AppLayout() {
  const user = useCurrentUser();
  const logout = useLogout();

  return (
    <InfoProvider>
      <ActivityLogProvider>
        <StatusHeader
          actions={
            <button
              type="button"
              className="btn-inline"
              disabled={logout.isPending}
              onClick={() => {
                logout.mutate();
              }}
            >
              ออกจากระบบ
            </button>
          }
        />
        <nav className="topnav" aria-label="เมนูหลัก">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            activeProps={{ className: 'active' }}
          >
            Dashboard
          </Link>
          <Link to="/archive" activeProps={{ className: 'active' }}>
            Archive
          </Link>
          <Link to="/account" activeProps={{ className: 'active' }}>
            บัญชีของฉัน
          </Link>
          <Can role="admin">
            <Link to="/admin/users" activeProps={{ className: 'active' }}>
              ผู้ใช้
            </Link>
            <Link to="/admin/audit" activeProps={{ className: 'active' }}>
              Audit log
            </Link>
          </Can>
          {user ? (
            <span className="who">
              {user.name} ({user.username}){' '}
              <span className="badge role">{user.role}</span>
            </span>
          ) : null}
        </nav>
        <Outlet />
      </ActivityLogProvider>
    </InfoProvider>
  );
}
