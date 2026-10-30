import { useEffect, useRef, useState } from 'react';
import { chartApi } from '../../api/terminal';
import type { ChartBar, ChartTimeframe } from '../../api/types';

export type StreamState =
  'connecting' | 'live' | 'reconnecting' | 'error' | 'closed';

/**
 * Live bar updates over Server-Sent Events (same origin, the session cookie authorises it).
 * `onBar` receives every forming/closing bar; the browser reconnects by itself.
 */
export function useChartStream(
  params: { symbol: string; source: string; tf: ChartTimeframe } | null,
  onBar: (bar: ChartBar) => void,
): { state: StreamState; message: string | null } {
  const key = params ? `${params.symbol}|${params.source}|${params.tf}` : null;
  const [snap, setSnap] = useState<{
    key: string | null;
    state: StreamState;
    message: string | null;
  }>({ key, state: 'connecting', message: null });
  const handler = useRef(onBar);
  useEffect(() => {
    handler.current = onBar;
  }, [onBar]);

  useEffect(() => {
    if (!params || typeof EventSource === 'undefined') return;
    const es = new EventSource(chartApi.streamUrl(params), {
      withCredentials: false,
    });
    es.addEventListener('bar', (e: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(e.data) as ChartBar);
        setSnap((s) =>
          s.key === key && s.state !== 'connecting'
            ? s
            : { key, state: 'live', message: null },
        );
      } catch {
        /* ignore a malformed event */
      }
    });
    es.addEventListener('status', (e: MessageEvent<string>) => {
      try {
        const s = JSON.parse(e.data) as {
          state: 'live' | 'reconnecting' | 'error';
          message?: string;
        };
        setSnap({ key, state: s.state, message: s.message ?? null });
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      setSnap({
        key,
        state: es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting',
        message: null,
      });
    };
    return () => {
      es.close();
    };
    // the key captures every param; onBar is read through a ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // a new key starts as "connecting" until its own first event arrives
  return snap.key === key
    ? { state: snap.state, message: snap.message }
    : { state: 'connecting', message: null };
}
