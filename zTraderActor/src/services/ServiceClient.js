/**
 * Thin native-fetch client for zTraderService's machine API (x-api-key).
 * Replaces axios. Error shape mirrors what the strategy code relied on:
 *   - non-2xx -> ServiceError with `status` and parsed `data`
 *   - timeout -> ServiceError with code 'ETIMEDOUT'
 *   - network -> ServiceError with the socket error code (e.g. 'ECONNREFUSED')
 */
export class ServiceError extends Error {
    constructor(message, { status, data, code, cause } = {}) {
        super(message, { cause });
        this.name = 'ServiceError';
        this.status = status;
        this.data = data;
        this.code = code;
    }
}

export class ServiceClient {
    /**
     * @param {{ baseUrl: string, apiKey: string, fetch?: typeof fetch }} opts
     */
    constructor({ baseUrl, apiKey, fetch: fetchImpl = globalThis.fetch }) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.fetch = fetchImpl;
    }

    url(path, query) {
        const u = new URL(this.baseUrl + path);
        for (const [k, v] of Object.entries(query ?? {})) {
            if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
        return u;
    }

    /**
     * Low-level call that never throws on HTTP status. Returns the raw Response.
     * @param {string} method
     * @param {string} path  path below baseUrl, starting with "/"
     * @param {{ query?: object, body?: unknown, timeoutMs?: number, actor?: string }} [opts]
     *   actor: who caused the call, sent as X-Actor-User for the service's audit log
     */
    async raw(method, path, { query, body, timeoutMs, actor } = {}) {
        const headers = { 'x-api-key': this.apiKey, accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (actor !== undefined) headers['x-actor-user'] = actor;
        try {
            return await this.fetch(this.url(path, query), {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
                redirect: 'error',
            });
        } catch (err) {
            if (err?.name === 'TimeoutError') {
                throw new ServiceError(`timeout of ${timeoutMs}ms exceeded`, { code: 'ETIMEDOUT', cause: err });
            }
            const code = err?.cause?.code;
            throw new ServiceError(err?.cause?.message ?? err?.message ?? 'request failed', { code, cause: err });
        }
    }

    /** axios-like: resolves with the parsed body, rejects with ServiceError on non-2xx. */
    async request(method, path, opts) {
        const res = await this.raw(method, path, opts);
        const data = await parseBody(res);
        if (!res.ok) {
            throw new ServiceError(`Request failed with status code ${res.status}`, { status: res.status, data });
        }
        return data;
    }

    get(path, opts) {
        return this.request('GET', path, opts);
    }

    post(path, body, opts) {
        return this.request('POST', path, { ...opts, body });
    }
}

export async function parseBody(res) {
    const text = await res.text();
    if (!text) return undefined;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    return text;
}
