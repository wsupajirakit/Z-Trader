import { useEffect, useState } from 'react';
import { dashboardApi } from '../../api/dashboard';
import type { Quote } from '../../api/types';

/**
 * Live bid/ask for the given instruments over one Server-Sent Events connection: the server sends
 * a price only when it moved and at most once a second. No symbols = no connection; the stream
 * also closes while the browser tab is hidden and reopens when it is shown again.
 */
export function useQuotes(symbols: readonly string[]): Record<string, Quote> {
  const key = [...new Set(symbols)].sort().join(',');
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [visible, setVisible] = useState(
    typeof document === 'undefined' || !document.hidden,
  );

  useEffect(() => {
    const onVisibility = () => {
      setVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!key || !visible || typeof EventSource === 'undefined') return;
    const es = new EventSource(dashboardApi.quotesStreamUrl(key.split(',')));
    es.addEventListener('quotes', (e: MessageEvent<string>) => {
      try {
        const next = JSON.parse(e.data) as Record<string, Quote | null>;
        setQuotes((prev) => {
          const out = { ...prev };
          for (const [s, q] of Object.entries(next)) if (q) out[s] = q;
          return out;
        });
      } catch {
        /* ignore a malformed event */
      }
    });
    return () => {
      es.close();
    };
  }, [key, visible]);

  return quotes;
}
