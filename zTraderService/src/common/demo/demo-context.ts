import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The "demo" role: everything a request from a demo session triggers runs inside this async context
 * (DemoInterceptor enters it). Code that would reach the broker with a trading command, call an AI
 * provider, send a notification or change shared state checks `demoContext.active` and refuses —
 * the last line of defence behind the interceptor, which already simulates every write.
 *
 * AsyncLocalStorage follows every promise, timer and callback started from the request, so work
 * spawned by a demo request stays marked as demo.
 */
const store = new AsyncLocalStorage<{ username: string }>();

export class DemoBlockedError extends Error {
    override readonly name = 'DemoBlockedError';
}

export const demoContext = {
    run<T>(username: string, fn: () => T): T {
        return store.run({ username }, fn);
    },
    get active(): boolean {
        return store.getStore() !== undefined;
    },
    get username(): string | null {
        return store.getStore()?.username ?? null;
    },
    /** throws when called from a demo request: `what` names the refused side effect */
    assertNotDemo(what: string): void {
        const s = store.getStore();
        if (s) throw new DemoBlockedError(`${what} is not allowed for the demo role (user "${s.username}")`);
    },
};
