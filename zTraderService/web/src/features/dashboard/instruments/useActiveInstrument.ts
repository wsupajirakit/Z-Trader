import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { InstrumentListItem } from '../../../api/types';
import { instrumentsQuery, statusQuery } from '../queries';
import {
  INST_DEFAULT,
  normalizeInstrument,
  type ActiveInstrument,
} from './instrument';

const EMPTY: InstrumentListItem[] = [];

/**
 * The active instrument as the original tracked it in `INST`: the server status wins,
 * then the `active` row of the instrument list, then gold.
 */
export function useActiveInstrument(): {
  active: ActiveInstrument;
  list: InstrumentListItem[];
  /** false until status or the instrument list has answered once */
  ready: boolean;
} {
  const { data: status } = useQuery(statusQuery);
  const { data: instruments } = useQuery(instrumentsQuery);
  const list = instruments?.list ?? EMPTY;

  const fromList =
    list.find((i) => i.active) ??
    list.find((i) => i.key === instruments?.active) ??
    null;
  const source = status?.instrument ?? fromList;

  const active = useMemo(
    () => (source ? normalizeInstrument(source) : INST_DEFAULT),
    [source],
  );
  return { active, list, ready: source !== null };
}
