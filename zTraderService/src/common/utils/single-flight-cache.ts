/**
 * Caches one async value for `ttlMs` and shares an in-flight request between concurrent callers
 * (single-flight), so N callers within the TTL cost one upstream request.
 * When the refresh fails, the last good value is served while it is younger than `staleMs`.
 */
export class SingleFlightCache<T> {
    private value: { at: number; data: T } | null = null;
    private inflight: Promise<T> | null = null;

    constructor(
        private readonly load: () => Promise<T>,
        private readonly ttlMs: number,
        private readonly staleMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    async get(): Promise<{ data: T; stale: boolean; ageMs: number }> {
        const cached = this.value;
        if (cached && this.now() - cached.at < this.ttlMs)
            return { data: cached.data, stale: false, ageMs: this.now() - cached.at };
        this.inflight ??= this.load()
            .then((data) => {
                this.value = { at: this.now(), data };
                return data;
            })
            .finally(() => {
                this.inflight = null;
            });
        try {
            const data = await this.inflight;
            return { data, stale: false, ageMs: 0 };
        } catch (e) {
            const old = this.value;
            if (old && this.now() - old.at < this.staleMs)
                return { data: old.data, stale: true, ageMs: this.now() - old.at };
            throw e;
        }
    }

    /** forget the cached value (the next get() reloads) */
    invalidate(): void {
        this.value = null;
    }
}
