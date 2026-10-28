export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export function hasRole(actual: Role, required: Role): boolean {
    return RANK[actual] >= RANK[required];
}
