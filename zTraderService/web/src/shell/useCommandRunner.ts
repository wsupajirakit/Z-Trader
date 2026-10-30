import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { Command } from './commands';
import { terminalStore } from './terminalStore';

/** executes a GO-bar / palette command */
export function useCommandRunner() {
  const navigate = useNavigate();
  return useCallback(
    (cmd: Command) => {
      if (cmd.kind === 'symbol') {
        terminalStore.set({ chartSymbol: cmd.symbol });
        if (cmd.then) void navigate({ to: cmd.then });
        return;
      }
      void navigate({ to: cmd.to });
    },
    [navigate],
  );
}
