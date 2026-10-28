/**
 * `catch (e)` is `unknown` under strict mode, and that is accurate: cTrader rejects with plain protobuf
 * payloads, axios with Error subclasses, and some libraries with strings. These helpers turn any of
 * those into something loggable without lying to the type system.
 */
export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        if (typeof o.message === 'string') return o.message;
        if (typeof o.description === 'string') return o.description;
        try {
            return JSON.stringify(e).slice(0, 500);
        } catch {
            return Object.prototype.toString.call(e);
        }
    }
    return String(e);
}

export function errorStack(e: unknown): string | undefined {
    return e instanceof Error ? e.stack : undefined;
}
