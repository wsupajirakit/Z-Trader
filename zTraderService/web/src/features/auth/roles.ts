import type { Role } from '../../api/types';

const RANK: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
  demo: 3,
};

/**
 * viewer < operator < admin — each role can do everything the lower ones can. `demo` sees and may press
 * everything; the server simulates its writes, so nothing it does trades, calls an AI or saves.
 */
export function hasRole(
  role: Role | null | undefined,
  required: Role,
): boolean {
  return role ? RANK[role] >= RANK[required] : false;
}

export const ROLES: readonly Role[] = ['viewer', 'operator', 'admin', 'demo'];

export const ROLE_LABEL: Record<Role, string> = {
  viewer: 'Viewer · read only',
  operator: 'Operator · trade and settings',
  admin: 'Admin · users and audit',
  demo: 'Demo · everything simulated (no orders, no AI calls, nothing saved)',
};
