/**
 * Only http(s) links from third-party data (RSS) may become an `href`. Anything else
 * (`javascript:`, `data:` …) is dropped.
 */
export function safeExternalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Accept only same-app paths ("/x", not "//host" or "https://…") as a post-login redirect. */
export function safeRedirectPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\'))
    return undefined;
  return raw;
}
