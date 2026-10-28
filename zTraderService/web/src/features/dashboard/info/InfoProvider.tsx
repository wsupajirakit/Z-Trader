import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { INFO, type InfoKey } from './infoContent';
import { OpenInfoContext } from './useOpenInfo';

/** Hosts the single help modal; any (i) button opens it by key. */
export function InfoProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<InfoKey | null>(null);
  const close = useCallback(() => {
    setOpen(null);
  }, []);

  return (
    <OpenInfoContext value={setOpen}>
      {children}
      {open ? <InfoModal infoKey={open} onClose={close} /> : null}
    </OpenInfoContext>
  );
}

function InfoModal({
  infoKey,
  onClose,
}: {
  infoKey: InfoKey;
  onClose: () => void;
}) {
  const entry = INFO[infoKey];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="modal"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-title"
      >
        <h3 id="info-title">{entry.title}</h3>
        <div className="mkey">{entry.keyText}</div>
        <div>{entry.body}</div>
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          autoFocus
        >
          ปิด
        </button>
      </div>
    </div>
  );
}
