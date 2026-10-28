import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';
import { qk } from '../../api/queryKeys';

const SECTIONS = {
  status: qk.dashboard.status,
  settings: qk.dashboard.settings,
  positions: qk.dashboard.positionsAll,
  all: qk.dashboard.all,
} satisfies Record<string, QueryKey>;

type Section = keyof typeof SECTIONS;

/** Refresh parts of the dashboard after an action (the original called refreshX()). */
export function useInvalidateDashboard(): (...sections: Section[]) => void {
  const qc = useQueryClient();
  return useCallback(
    (...sections: Section[]) => {
      for (const s of sections)
        void qc.invalidateQueries({ queryKey: SECTIONS[s] });
    },
    [qc],
  );
}
