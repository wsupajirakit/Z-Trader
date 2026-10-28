import { createContext, use } from 'react';
import type { InfoKey } from './infoContent';

type OpenInfo = (key: InfoKey) => void;

export const OpenInfoContext = createContext<OpenInfo | null>(null);

export function useOpenInfo(): OpenInfo {
  const open = use(OpenInfoContext);
  if (!open) throw new Error('useOpenInfo must be used inside <InfoProvider>');
  return open;
}
