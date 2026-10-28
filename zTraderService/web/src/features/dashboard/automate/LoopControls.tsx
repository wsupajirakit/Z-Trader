import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import type { GoldMode } from '../../../api/types';
import { dialogs } from '../../../lib/dialogs';
import { Can } from '../../auth/Can';
import { useCan } from '../../auth/session';
import { useActivityLog } from '../activity/ActivityLogContext';
import { InfoButton } from '../info/InfoButton';
import { useActiveInstrument } from '../instruments/useActiveInstrument';
import { statusQuery } from '../queries';
import { useInvalidateDashboard } from '../useInvalidateDashboard';
import {
  boxTitle,
  checkedInOrder,
  shownValues,
  toggleValue,
  UNTOUCHED,
  type LoopSelection,
} from './loopSelection';
import { useModes } from './useModes';

const DEFAULT_MODES = ['swing'];

/** "Loop อัตโนมัติ": instrument + mode checkboxes and Start / Stop. */
export function LoopControls() {
  const { data: status } = useQuery(statusQuery);
  const { active, list } = useActiveInstrument();
  const modes = useModes();
  const canOperate = useCan('operator');
  const log = useActivityLog();
  const qc = useQueryClient();
  const invalidate = useInvalidateDashboard();

  const [modeSel, setModeSel] = useState<LoopSelection>(UNTOUCHED);
  const [instSel, setInstSel] = useState<LoopSelection>(UNTOUCHED);

  const running = !!status?.enabled;
  // Seen running (from this tab or another): the server is the truth again.
  if (running && (modeSel.dirty || instSel.dirty)) {
    setModeSel((s) => ({ ...s, dirty: false }));
    setInstSel((s) => ({ ...s, dirty: false }));
  }

  const modeOptions = modes.map((m) => m.mode);
  const instOptions = list.length ? list.map((i) => i.key) : [active.key];
  const shownModes = shownValues(
    modeSel,
    running,
    status?.modes,
    DEFAULT_MODES,
  );
  const shownInsts = shownValues(
    instSel,
    running,
    status?.enabled_instruments,
    [active.key],
  );

  const automate = useMutation({
    mutationFn: dashboardApi.automate,
    onSuccess: (next, { enabled, modes: m = [], instruments = [] }) => {
      qc.setQueryData(statusQuery.queryKey, next);
      log.append(
        'auto loop ' +
          (enabled
            ? 'เปิด: ' + instruments.join(',') + ' × ' + m.join(', ')
            : 'ปิด'),
        enabled ? 'order' : 'warn',
      );
    },
    onError: (e) => {
      log.append('❌ auto loop: ' + describeError(e), 'error');
    },
    onSettled: () => {
      // Handed to the server: trust the server again.
      setModeSel((s) => ({ ...s, dirty: false }));
      setInstSel((s) => ({ ...s, dirty: false }));
      invalidate('status');
    },
  });

  const setLoop = (enabled: boolean) => {
    const pickedModes = checkedInOrder(modeOptions, shownModes) as GoldMode[];
    const pickedInsts = checkedInOrder(instOptions, shownInsts);
    if (enabled && !pickedModes.length) {
      dialogs.alert('เลือกอย่างน้อย 1 โหมด');
      return;
    }
    if (enabled && !pickedInsts.length) {
      dialogs.alert('เลือกอย่างน้อย 1 ตราสาร');
      return;
    }
    automate.mutate({ enabled, modes: pickedModes, instruments: pickedInsts });
  };

  const locked = running || !canOperate;

  return (
    <>
      <span className="lbl m14">
        Loop อัตโนมัติ — เลือกตราสาร (เทรดพร้อมกันได้หลายตัว){' '}
        <InfoButton k="loopinst" />
      </span>
      <div className="checks">
        {instOptions.map((key) => {
          const item = list.find((i) => i.key === key);
          const checked = shownInsts.includes(key);
          return (
            <CheckBox
              key={key}
              label={(item?.emoji ?? active.emoji) + ' ' + key}
              checked={checked}
              running={running}
              disabled={locked}
              title={boxTitle(running, checked, 'instrument')}
              onChange={(on) => {
                setInstSel(toggleValue(shownInsts, key, on));
              }}
            />
          );
        })}
      </div>
      <span className="lbl m10">
        Loop อัตโนมัติ — เลือกโหมด <InfoButton k="loop" />
      </span>
      <div className="checks">
        {modeOptions.map((m) => {
          const checked = shownModes.includes(m);
          return (
            <CheckBox
              key={m}
              label={m}
              checked={checked}
              running={running}
              disabled={locked}
              title={boxTitle(running, checked, 'mode')}
              onChange={(on) => {
                setModeSel(toggleValue(shownModes, m, on));
              }}
            />
          );
        })}
      </div>
      <Can role="operator">
        <div className="row">
          {running ? (
            <button
              type="button"
              className="btn-stop"
              disabled={automate.isPending}
              onClick={() => {
                setLoop(false);
              }}
            >
              Stop Auto Loop
            </button>
          ) : (
            <button
              type="button"
              className="btn-start"
              disabled={automate.isPending}
              onClick={() => {
                setLoop(true);
              }}
            >
              Start Auto Loop
            </button>
          )}
        </div>
      </Can>
    </>
  );
}

function CheckBox({
  label,
  checked,
  running,
  disabled,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  running: boolean;
  disabled: boolean;
  title: string;
  onChange: (checked: boolean) => void;
}) {
  // running: green (this one is live) / dimmer grey (not part of this run)
  const cls = running ? (checked ? 'running' : 'running off') : undefined;
  return (
    <label className={cls} title={title || undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />{' '}
      {label}
    </label>
  );
}
