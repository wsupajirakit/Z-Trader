import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage';
import { LoginPage } from '../features/auth/LoginPage';
import {
  validateArchiveFileSearch,
  validateArchiveSearch,
} from '../features/dashboard/archive/archiveSearch';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { safeRedirectPath } from '../lib/safeUrl';
import { AppLayout } from './AppLayout';
import {
  guardApp,
  guardGuest,
  guardRole,
  requireSession,
  type RouterContext,
} from './guards';
import { NotFound, RouteError } from './RouteFallbacks';

/*
 * Code-based route tree (no generated file): small, explicit, and every guard is visible here.
 *
 *   /login                   guest only
 *   /change-password         any session (forced when mustChangePassword)
 *   (app)                    signed in, password already changed      → AppLayout
 *     /                      dashboard
 *     /archive               archive list
 *     /archive/$mode/$file   archive viewer
 *     /account               my sessions + change password
 *     /admin                 admin only
 *       /admin/users
 *       /admin/audit
 */

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirectPath(search.redirect);
    return target ? { redirect: target } : {};
  },
  beforeLoad: guardGuest,
  component: LoginPage,
});

const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'change-password',
  beforeLoad: async (args) => ({ session: await requireSession(args) }),
  component: ChangePasswordPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: guardApp,
  component: AppLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DashboardPage,
});

const archiveRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'archive',
  validateSearch: validateArchiveSearch,
  component: lazyRouteComponent(
    () => import('../features/dashboard/archive/ArchiveListPage'),
    'ArchiveListPage',
  ),
});

const archiveFileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'archive/$mode/$file',
  validateSearch: validateArchiveFileSearch,
  component: lazyRouteComponent(
    () => import('../features/dashboard/archive/ArchiveFilePage'),
    'ArchiveFilePage',
  ),
});

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'account',
  component: lazyRouteComponent(
    () => import('../features/account/AccountPage'),
    'AccountPage',
  ),
});

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'admin',
  beforeLoad: guardRole('admin'),
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/admin/users' });
  },
});

const usersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'users',
  component: lazyRouteComponent(
    () => import('../features/users/UsersPage'),
    'UsersPage',
  ),
});

const auditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'audit',
  component: lazyRouteComponent(
    () => import('../features/audit/AuditPage'),
    'AuditPage',
  ),
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  changePasswordRoute,
  appRoute.addChildren([
    dashboardRoute,
    archiveRoute,
    archiveFileRoute,
    accountRoute,
    adminRoute.addChildren([adminIndexRoute, usersRoute, auditRoute]),
  ]),
]);

export function createAppRouter(options: {
  queryClient: QueryClient;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree,
    context: { queryClient: options.queryClient },
    ...(options.history ? { history: options.history } : {}),
    defaultPreload: 'intent',
    // Route data comes from TanStack Query, which has its own cache.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
