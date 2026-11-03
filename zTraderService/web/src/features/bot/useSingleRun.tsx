import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type { GoldMode } from '../../api/types';
import { useDialogs } from '../../components/dialogs/context';
import { modesQuery, statusQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { useInstruments } from '../../data/useInstruments';
import { useCan } from '../auth/session';

interface LastRound {
  label: string;
  outcome: string;
  at: number;
}

/**
 * One analysis round now: "Run" may place an order, "Analyze" parks the decision for review.
 * A second press (and every one after it) asks first, showing what the previous round did, so a
 * double click or a forgotten earlier run never fires another round unseen.
 */
export function useSingleRun() {
  const { active } = useInstruments();
  const { data } = useQuery(modesQuery(active));
  const { data: status } = useQuery(statusQuery);
  const canOperate = useCan('operator');
  const dialogs = useDialogs();
  const [picked, setPicked] = useState<GoldMode>('swing');
  const [last, setLast] = useState<LastRound | null>(null);
  const modes = data?.modes ?? [];
  const mode =
    modes.some((m) => m.mode === picked) || !modes.length
      ? picked
      : (modes[0]?.mode ?? 'swing');

  const run = useAction({
    fn: (v: { mode: GoldMode; analyzeOnly: boolean }) =>
      v.analyzeOnly
        ? dashboardApi.analyze({ mode: v.mode, force: true })
        : dashboardApi.run({ mode: v.mode, force: true }),
    invalidate: [qk.dashboard.status, qk.dashboard.positionsAll],
    success: (r, v) =>
      `${v.analyzeOnly ? 'Analyze' : 'Run'} ${v.mode}: ${r.outcome}`,
    failure: (m, v) =>
      `${v.analyzeOnly ? 'Analyze' : 'Run'} ${v.mode} failed: ${m}`,
    tag: 'manual',
    onSuccess: (r, v) => {
      setLast({
        label: `${v.analyzeOnly ? 'Analyze' : 'Run'} ${v.mode}`,
        outcome: r.outcome,
        at: Date.now(),
      });
    },
  });

  const fire = async (analyzeOnly: boolean) => {
    if (last) {
      const mins = Math.max(0, Math.round((Date.now() - last.at) / 60_000));
      const verb = analyzeOnly ? 'Analyze' : 'Run';
      const ok = await dialogs.confirm({
        title: analyzeOnly ? 'Analyze again' : 'Run another round',
        message: (
          <>
            The last round (<b>{last.label}</b>: {last.outcome}) finished{' '}
            {mins ? `${mins} min ago` : 'just now'}.{' '}
            {analyzeOnly
              ? 'Analyze once more?'
              : `Run ${mode} again on ${status?.accountMode ?? 'DEMO'}? It may place an order.`}
          </>
        ),
        confirmLabel: `${verb} again`,
        tone:
          !analyzeOnly && status?.accountMode === 'LIVE' ? 'danger' : 'primary',
      });
      if (!ok) return;
    }
    run.mutate({ mode, analyzeOnly });
  };

  return {
    active,
    modes,
    mode,
    setMode: setPicked,
    canOperate,
    loopRunning: !!status?.enabled,
    pending: run.isPending,
    fire,
  };
}

export type SingleRun = ReturnType<typeof useSingleRun>;
