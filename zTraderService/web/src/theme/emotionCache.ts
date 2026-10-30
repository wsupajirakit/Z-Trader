import createCache, { type EmotionCache } from '@emotion/cache';

/**
 * The CSP allows <style> tags only with this response's nonce. The server writes it into
 * <meta property="csp-nonce" nonce="…"> (browsers hide the attribute value, the property keeps it).
 */
export function readCspNonce(doc: Document = document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
  const nonce = meta?.nonce || meta?.getAttribute('nonce') || '';
  return nonce && nonce !== '__CSP_NONCE__' ? nonce : undefined;
}

export function createEmotionCache(): EmotionCache {
  const nonce = readCspNonce();
  return createCache({ key: 'zt', prepend: true, ...(nonce ? { nonce } : {}) });
}
