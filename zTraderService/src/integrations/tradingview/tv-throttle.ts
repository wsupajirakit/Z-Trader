/**
 * Global spacing between new TradingView sessions (port of z-service throttle.py).
 *
 * TradingView drops anonymous websocket connections that arrive in bursts (~10 back to back trips the
 * limit), so every session open reserves a slot here and waits for it. After repeated failures the
 * caller can trip a cooldown that holds every new session for a while.
 */
export class TvThrottle {
    private nextAt = 0;
    private cooldownUntil = 0;

    constructor(
        private readonly minIntervalMs = 750,
        private readonly now: () => number = Date.now,
    ) {}

    /** reserve the next slot; resolves when it arrives */
    waitTurn(): Promise<void> {
        const now = this.now();
        const startAt = Math.max(now, this.nextAt, this.cooldownUntil);
        this.nextAt = startAt + this.minIntervalMs;
        const wait = startAt - now;
        if (wait <= 0) return Promise.resolve();
        return new Promise((resolve) => setTimeout(resolve, wait).unref());
    }

    tripCooldown(ms: number): void {
        this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + ms);
    }

    cooldownLeftMs(): number {
        return Math.max(0, this.cooldownUntil - this.now());
    }
}
