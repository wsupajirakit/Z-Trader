/**
 * A rule the caller broke (bad value, wrong state, stale id): safe to show to the user, mapped to 400.
 * Anything else that escapes a gold service is treated as a server fault (logged, generic 500).
 */
export class DomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DomainError';
    }
}

/** a round that decided not to send its order (not a fault): recorded as `skipped`, no alert */
export class OrderSkipped extends DomainError {
    constructor(message: string) {
        super(message);
        this.name = 'OrderSkipped';
    }
}
