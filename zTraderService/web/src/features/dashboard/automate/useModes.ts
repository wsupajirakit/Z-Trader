import { useQuery } from '@tanstack/react-query';
import type { ModeInfo } from '../../../api/types';
import { useActiveInstrument } from '../instruments/useActiveInstrument';
import { modesQuery } from '../queries';

const EMPTY: ModeInfo[] = [];

/** Modes of the active instrument (refetched when the instrument changes). */
export function useModes(): ModeInfo[] {
  const { active, ready } = useActiveInstrument();
  const { data } = useQuery({ ...modesQuery(active.key), enabled: ready });
  return data?.modes ?? EMPTY;
}
