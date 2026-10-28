import type { ReactNode } from 'react';
import type { InfoKey } from './infoContent';
import { useOpenInfo } from './useOpenInfo';

/** The round (i) button, or a pill with a label (`variant`). */
export function InfoButton({
  k,
  children = 'i',
  variant,
  title,
}: {
  k: InfoKey;
  children?: ReactNode;
  variant?: 'pill' | 'pill-lg' | 'pill-lg pill-green';
  title?: string;
}) {
  const open = useOpenInfo();
  return (
    <button
      type="button"
      className={variant ? `info ${variant}` : 'info'}
      title={title}
      aria-label={
        typeof children === 'string' && children !== 'i'
          ? undefined
          : `คำอธิบาย ${k}`
      }
      onClick={() => {
        open(k);
      }}
    >
      {children}
    </button>
  );
}
