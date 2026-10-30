import { createContext, useContext, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  details?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  /** the user must type this word before the confirm button enables */
  requireText?: string;
}

export interface PromptOptions {
  title: string;
  label: string;
  message?: ReactNode;
  defaultValue?: string;
  submitLabel?: string;
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
}

export interface Dialogs {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** null = cancelled */
  prompt: (opts: PromptOptions) => Promise<string | null>;
  alert: (title: string, message: ReactNode) => Promise<void>;
}

export type NotifyFn = (
  message: string,
  severity?: 'success' | 'info' | 'warning' | 'error',
) => void;

export const DialogContext = createContext<Dialogs | null>(null);
export const NotifyContext = createContext<NotifyFn | null>(null);

export function useDialogs(): Dialogs {
  const d = useContext(DialogContext);
  if (!d) throw new Error('useDialogs needs <DialogProvider>');
  return d;
}

/** toast message (bottom right) */
export function useNotify(): NotifyFn {
  const n = useContext(NotifyContext);
  if (!n) throw new Error('useNotify needs <DialogProvider>');
  return n;
}
