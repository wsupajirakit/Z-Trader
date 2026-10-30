import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Snackbar from '@mui/material/Snackbar';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DialogContext,
  type ConfirmOptions,
  type Dialogs,
  type NotifyFn,
  type PromptOptions,
  NotifyContext,
} from './context';

type Pending =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }
  | {
      kind: 'alert';
      opts: { title: string; message: ReactNode };
      resolve: () => void;
    };

interface Toast {
  key: number;
  message: string;
  severity: 'success' | 'info' | 'warning' | 'error';
}

/**
 * In-app replacements for window.confirm / prompt / alert (themed MUI dialogs, promise based)
 * plus a toast queue. One dialog at a time; calls made while one is open wait their turn.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const seq = useRef(0);
  const current = queue[0] ?? null;

  const push = useCallback((p: Pending) => {
    setQueue((q) => {
      if (!q.length && p.kind === 'prompt') setText(p.opts.defaultValue ?? '');
      return [...q, p];
    });
  }, []);

  const close = useCallback(() => {
    setQueue((q) => {
      const rest = q.slice(1);
      const next = rest[0];
      if (next?.kind === 'prompt') setText(next.opts.defaultValue ?? '');
      else setText('');
      return rest;
    });
  }, []);

  const dialogs = useMemo<Dialogs>(
    () => ({
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          push({ kind: 'confirm', opts, resolve });
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          push({ kind: 'prompt', opts, resolve });
        }),
      alert: (title, message) =>
        new Promise<void>((resolve) => {
          push({ kind: 'alert', opts: { title, message }, resolve });
        }),
    }),
    [push],
  );

  const notify = useCallback<NotifyFn>((message, severity = 'info') => {
    seq.current += 1;
    setToast({ key: seq.current, message, severity });
  }, []);

  const cancel = () => {
    if (!current) return;
    if (current.kind === 'confirm') current.resolve(false);
    else if (current.kind === 'prompt') current.resolve(null);
    else current.resolve();
    close();
  };

  const accept = () => {
    if (!current) return;
    if (current.kind === 'confirm') current.resolve(true);
    else if (current.kind === 'prompt') current.resolve(text);
    else current.resolve();
    close();
  };

  const typed =
    current?.kind === 'confirm' && current.opts.requireText
      ? current.opts.requireText
      : null;
  const acceptDisabled =
    (typed !== null && text.trim() !== typed) ||
    (current?.kind === 'prompt' && !!current.opts.required && !text.trim());
  const danger = current?.kind === 'confirm' && current.opts.tone === 'danger';

  return (
    <DialogContext.Provider value={dialogs}>
      <NotifyContext.Provider value={notify}>
        {children}
        <Dialog
          open={!!current}
          onClose={cancel}
          maxWidth="xs"
          fullWidth
          aria-labelledby="zt-dialog-title"
          slotProps={{ transition: { timeout: 120 } }}
        >
          {current ? (
            <Box
              component="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!acceptDisabled) accept();
              }}
            >
              <DialogTitle id="zt-dialog-title">
                {current.opts.title}
              </DialogTitle>
              <DialogContent>
                {current.kind === 'prompt' ? (
                  <>
                    {current.opts.message ? (
                      <Typography variant="body2" sx={{ mb: 3 }}>
                        {current.opts.message}
                      </Typography>
                    ) : null}
                    <TextField
                      autoFocus
                      fullWidth
                      label={current.opts.label}
                      value={text}
                      multiline={current.opts.multiline}
                      minRows={current.opts.multiline ? 2 : undefined}
                      onChange={(e) => {
                        setText(e.target.value);
                      }}
                      slotProps={{
                        htmlInput: { maxLength: current.opts.maxLength ?? 300 },
                      }}
                    />
                  </>
                ) : (
                  <>
                    <Box sx={{ fontSize: 12.5, lineHeight: 1.6 }}>
                      {current.opts.message}
                    </Box>
                    {current.kind === 'confirm' && current.opts.details ? (
                      <Box sx={{ mt: 3 }}>{current.opts.details}</Box>
                    ) : null}
                    {typed !== null ? (
                      <TextField
                        autoFocus
                        fullWidth
                        sx={{ mt: 3 }}
                        label={`Type ${typed} to confirm`}
                        value={text}
                        onChange={(e) => {
                          setText(e.target.value);
                        }}
                      />
                    ) : null}
                  </>
                )}
              </DialogContent>
              <DialogActions>
                {current.kind !== 'alert' ? (
                  <Button onClick={cancel} color="inherit">
                    {current.kind === 'confirm'
                      ? (current.opts.cancelLabel ?? 'Cancel')
                      : 'Cancel'}
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  variant="contained"
                  color={danger ? 'error' : 'primary'}
                  disabled={acceptDisabled}
                  autoFocus={current.kind !== 'prompt' && typed === null}
                >
                  {current.kind === 'confirm'
                    ? (current.opts.confirmLabel ?? 'Confirm')
                    : current.kind === 'prompt'
                      ? (current.opts.submitLabel ?? 'OK')
                      : 'OK'}
                </Button>
              </DialogActions>
            </Box>
          ) : null}
        </Dialog>
        <Snackbar
          key={toast?.key}
          open={!!toast}
          autoHideDuration={toast?.severity === 'error' ? 8000 : 4000}
          onClose={(_e, reason) => {
            if (reason !== 'clickaway') setToast(null);
          }}
        >
          <Alert
            variant="filled"
            severity={toast?.severity ?? 'info'}
            onClose={() => {
              setToast(null);
            }}
            sx={{ maxWidth: 480 }}
          >
            {toast?.message}
          </Alert>
        </Snackbar>
      </NotifyContext.Provider>
    </DialogContext.Provider>
  );
}
