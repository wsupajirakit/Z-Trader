/**
 * viewer < operator < admin. `demo` passes every role check (it may open every screen and press every
 * button), but every write it makes is simulated and nothing it triggers can trade, call an AI provider
 * or change shared state — see src/common/demo/.
 */
export const ROLES = ['viewer', 'operator', 'admin', 'demo'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, demo: 3 };

export function hasRole(actual: Role, required: Role): boolean {
    return RANK[actual] >= RANK[required];
}
