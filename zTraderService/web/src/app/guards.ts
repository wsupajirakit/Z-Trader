import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import type { AuthPayload, Role } from '../api/types';
import { hasRole } from '../features/auth/roles';
import { loadSession } from '../features/auth/session';

export interface RouterContext {
  queryClient: QueryClient;
}

interface GuardArgs {
  context: RouterContext;
  location: { href: string; pathname: string };
}

/** Signed in at all? Otherwise go to /login and come back afterwards. */
export async function requireSession({
  context,
  location,
}: GuardArgs): Promise<AuthPayload> {
  const session = await loadSession(context.queryClient);
  if (!session) {
    throw redirect({ to: '/login', search: { redirect: location.href } });
  }
  return session;
}

/**
 * Guard of the signed-in app shell: needs a session, and a user who still has to change the
 * password is sent to the forced change-password screen before anything else.
 */
export async function guardApp(
  args: GuardArgs,
): Promise<{ session: AuthPayload }> {
  const session = await requireSession(args);
  if (session.user.mustChangePassword)
    throw redirect({ to: '/change-password' });
  return { session };
}

/** The login screen is for signed-out users only. */
export async function guardGuest({
  context,
}: Pick<GuardArgs, 'context'>): Promise<void> {
  const session = await loadSession(context.queryClient);
  if (session) throw redirect({ to: '/' });
}

/** Role gate for a subtree; runs after `guardApp`, so the session is in the route context. */
export function guardRole(required: Role) {
  return ({ context }: { context: { session: AuthPayload } }): void => {
    if (!hasRole(context.session.user.role, required))
      throw redirect({ to: '/' });
  };
}
