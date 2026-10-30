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
import {
  validateArchiveFileSearch,
  validateArchiveSearch,
} from '../features/archive/archiveSearch';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage';
import { LoginPage } from '../features/auth/LoginPage';
import { safeRedirectPath } from '../lib/safeUrl';
import { TerminalPage } from '../pages/TerminalPage';
import { TerminalShell } from '../shell/TerminalShell';
import {
  guardApp,
  guardGuest,
  guardRole,
  requireSession,
  type RouterContext,
} from './guards';
import { NotFound, RouteError } from './RouteFallbacks';

/*
 * Code-based route tree:
 *
 *   /login                   guest only
 *   /change-password         any session (forced when mustChangePassword)
 *   (app)                    signed in, password changed      → TerminalShell
 *     /                      terminal (Launchpad workspaces)
 *     /chart /bot /strategy /trades /news /settings
 *     /archive, /archive/$mode/$file
 *     /account
 *     /admin/users, /admin/audit   admin only
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
  component: TerminalShell,
});

const terminalRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: TerminalPage,
});
const chartRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'chart',
  component: lazyRouteComponent(
    () => import('../pages/ChartPage'),
    'ChartPage',
  ),
});
const botRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'bot',
  component: lazyRouteComponent(() => import('../pages/BotPage'), 'BotPage'),
});
const strategyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'strategy',
  component: lazyRouteComponent(
    () => import('../pages/StrategyPage'),
    'StrategyPage',
  ),
});
const tradesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'trades',
  component: lazyRouteComponent(
    () => import('../pages/TradesPage'),
    'TradesPage',
  ),
});
const newsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'news',
  component: lazyRouteComponent(() => import('../pages/NewsPage'), 'NewsPage'),
});
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'settings',
  component: lazyRouteComponent(
    () => import('../pages/SettingsPage'),
    'SettingsPage',
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

const archiveRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'archive',
  validateSearch: validateArchiveSearch,
  component: lazyRouteComponent(
    () => import('../features/archive/ArchiveListPage'),
    'ArchiveListPage',
  ),
});

const archiveFileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'archive/$mode/$file',
  validateSearch: validateArchiveFileSearch,
  component: lazyRouteComponent(
    () => import('../features/archive/ArchiveFilePage'),
    'ArchiveFilePage',
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
    () => import('../features/admin/UsersPage'),
    'UsersPage',
  ),
});

const auditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'audit',
  component: lazyRouteComponent(
    () => import('../features/admin/AuditPage'),
    'AuditPage',
  ),
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  changePasswordRoute,
  appRoute.addChildren([
    terminalRoute,
    chartRoute,
    botRoute,
    strategyRoute,
    tradesRoute,
    newsRoute,
    settingsRoute,
    accountRoute,
    archiveRoute,
    archiveFileRoute,
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
