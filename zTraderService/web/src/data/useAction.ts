import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { describeError } from '../api/client';
import { useNotify } from '../components/dialogs/context';
import { useActivityLog } from '../features/activity/ActivityLogContext';

/** the server's answer to a write made by the demo role (src/common/demo/demo.interceptor.ts) */
export interface SimulatedResult {
  demo: true;
  simulated: true;
  message: string;
}

export function isSimulated(r: unknown): r is SimulatedResult {
  return (
    typeof r === 'object' &&
    r !== null &&
    (r as { simulated?: unknown }).simulated === true
  );
}

/**
 * A write from the UI: runs the request, writes the outcome to the System Log and a toast,
 * then refreshes the given queries whatever happened.
 */
export function useAction<V, R>(opts: {
  fn: (v: V) => Promise<R>;
  invalidate?: readonly QueryKey[];
  success?: (r: R, v: V) => string | null;
  failure?: (message: string, v: V) => string;
  tag?: string;
  onSuccess?: (r: R, v: V) => void;
}) {
  const qc = useQueryClient();
  const log = useActivityLog();
  const notify = useNotify();
  return useMutation({
    mutationFn: opts.fn,
    onSuccess: (r, v) => {
      if (isSimulated(r)) {
        log.append(`[DEMO] ${r.message}`, 'warn', opts.tag ?? null);
        notify(r.message, 'info');
        // close dialogs / reset forms as after a real success (handlers here never read the result)
        opts.onSuccess?.(r, v);
        return;
      }
      const msg = opts.success?.(r, v);
      if (msg) {
        log.append(msg, 'order', opts.tag ?? null);
        notify(msg, 'success');
      }
      opts.onSuccess?.(r, v);
    },
    onError: (e, v) => {
      const msg = opts.failure
        ? opts.failure(describeError(e), v)
        : describeError(e);
      log.append(msg, 'error', opts.tag ?? null);
      notify(msg, 'error');
    },
    onSettled: async () => {
      await Promise.all(
        (opts.invalidate ?? []).map((queryKey) =>
          qc.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}
