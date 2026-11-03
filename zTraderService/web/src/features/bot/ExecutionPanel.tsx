import ExpandMore from '@mui/icons-material/ExpandMore';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import { useState, type ReactNode } from 'react';
import { useDialogs } from '../../components/dialogs/context';
import { capsLabel } from '../../theme/theme';
import { LoopAction, LoopSettings } from './ExecutionControl';
import { SingleRunActions, SingleRunSettings } from './ManualRun';
import { useLoopControl } from './useLoopControl';
import { useSingleRun } from './useSingleRun';

type ExecMode = 'loop' | 'single';

const TITLES: Record<ExecMode, string> = {
  loop: 'Auto loop',
  single: 'Single round',
};

/**
 * Execution control: the auto loop and a single round are two separate sections and only one of
 * them is in use at a time. The loop section is open by default; a section header opens or
 * folds its own section. Moving to the other section always asks first, and when the loop is
 * running the switch stops it before the single round opens. The section's start buttons sit in
 * its header, so they stay in view however far the settings scroll.
 */
export function ExecutionPanel() {
  const loop = useLoopControl();
  const single = useSingleRun();
  const dialogs = useDialogs();
  const [mode, setMode] = useState<ExecMode>('loop');
  const [open, setOpen] = useState(true);

  const select = async (target: ExecMode) => {
    if (target === mode) {
      setOpen(!open);
      return;
    }
    const stopLoop = target === 'single' && loop.running;
    if (loop.canOperate) {
      const ok = await dialogs.confirm({
        title: stopLoop
          ? 'Stop the loop and switch to a single round'
          : `Switch to ${TITLES[target].toLowerCase()}`,
        message: stopLoop ? (
          <>
            The auto loop is running on{' '}
            <b>{loop.status?.accountMode ?? 'DEMO'}</b>. Switching stops it
            first; open positions stay as they are.
          </>
        ) : (
          `${TITLES[mode]} closes. Only one execution mode is in use at a time.`
        ),
        confirmLabel: stopLoop ? 'Stop loop and switch' : 'Switch',
        tone: stopLoop ? 'danger' : 'primary',
      });
      if (!ok) return;
      if (stopLoop) {
        try {
          await loop.stop();
        } catch {
          return; // the loop is still running: stay on it (the failure is already shown)
        }
      }
    }
    setMode(target);
    setOpen(true);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Section
        id="exec-loop"
        title={TITLES.loop}
        status={loop.running ? '● running' : '○ stopped'}
        live={loop.running}
        expanded={mode === 'loop' && open}
        onToggle={() => void select('loop')}
        actions={mode === 'loop' ? <LoopAction loop={loop} /> : null}
      >
        <LoopSettings loop={loop} />
      </Section>
      <Section
        id="exec-single"
        title={TITLES.single}
        status={single.active}
        expanded={mode === 'single' && open}
        onToggle={() => void select('single')}
        actions={
          mode === 'single' && open ? (
            <SingleRunActions single={single} />
          ) : null
        }
      >
        <SingleRunSettings single={single} />
      </Section>
    </Box>
  );
}

function Section({
  id,
  title,
  status,
  live = false,
  expanded,
  onToggle,
  actions,
  children,
}: {
  id: string;
  title: string;
  status: string;
  live?: boolean;
  expanded: boolean;
  onToggle: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box
      component="section"
      aria-labelledby={`${id}-title`}
      sx={{
        border: 1,
        borderColor: expanded ? 'primary.main' : 'divider',
        borderRadius: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <ButtonBase
          id={`${id}-title`}
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          aria-label={title}
          onClick={onToggle}
          sx={{ flex: 1, justifyContent: 'flex-start', gap: 1, px: 1, py: 1 }}
        >
          <ExpandMore
            fontSize="small"
            sx={{
              transform: expanded ? 'rotate(180deg)' : 'none',
              transition: 'transform 150ms',
            }}
          />
          <Box sx={{ ...capsLabel, fontSize: 11 }}>{title}</Box>
          <Box
            sx={{
              ...capsLabel,
              fontSize: 10,
              color: live ? 'terminal.up' : 'text.secondary',
            }}
          >
            {status}
          </Box>
        </ButtonBase>
        {actions}
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <Box id={`${id}-body`} sx={{ px: 1.5, pb: 1.5 }}>
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}
