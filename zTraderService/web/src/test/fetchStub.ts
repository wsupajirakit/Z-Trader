import { vi } from 'vitest';

export interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

type Responder = (req: Recorded) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Replace global fetch. `routes` maps "METHOD /path" (no query string) to a body or a responder;
 * anything else answers 404. Returns the list of requests made.
 */
export function stubFetch(routes: Record<string, unknown>): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const raw = typeof init.body === 'string' ? init.body : undefined;
      const req: Recorded = {
        method,
        url: input,
        headers: new Headers(init.headers),
        body: raw === undefined ? undefined : (JSON.parse(raw) as unknown),
      };
      calls.push(req);
      const path = input.split('?')[0] ?? input;
      const hit = routes[`${method} ${path}`];
      if (hit === undefined)
        return json({ statusCode: 404, message: 'Not Found' }, 404);
      return typeof hit === 'function' ? (hit as Responder)(req) : json(hit);
    }),
  );
  return calls;
}
