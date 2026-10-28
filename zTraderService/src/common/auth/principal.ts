import type { Role } from './roles';

export interface SessionUser {
    id: string;
    username: string;
    name: string;
    role: Role;
    mustChangePassword: boolean;
}

export interface SessionPrincipal {
    kind: 'session';
    user: SessionUser;
    sessionId: string;
    csrfToken: string;
}

export interface ApiKeyPrincipal {
    kind: 'apiKey';
}

export type Principal = SessionPrincipal | ApiKeyPrincipal;
