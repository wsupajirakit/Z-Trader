import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import type { BotSettings } from '../../../api/types';
import { Can } from '../../auth/Can';
import { useCan } from '../../auth/session';
import { useActivityLog } from '../activity/ActivityLogContext';
import { InfoButton } from '../info/InfoButton';
import { settingsQuery } from '../queries';
import { useInvalidateDashboard } from '../useInvalidateDashboard';
import {
  matchPreset,
  PRESET_BUTTONS,
  PRESETS,
  TA_MAX_CONFIDENCE,
  tinyPresetWarning,
  type PresetNumber,
  type RiskPreset,
} from './presets';
import {
  applyPresetToDraft,
  draftFromSettings,
  draftToUpdate,
  EMPTY_DRAFT,
  RISK_FIELDS,
  type RiskDraft,
} from './riskForm';

/** A message that replaces the settings note until the next settings load. */
interface Note {
  text: string;
  at: number;
}

/** ⚠️ ความเสี่ยงที่ยอมรับได้ — risk inputs, one-click presets, save. */
export function RiskSettingsCard() {
  const settings = useQuery(settingsQuery);
  const { data: s, dataUpdatedAt } = settings;
  const canOperate = useCan('operator');
  const log = useActivityLog();
  const invalidate = useInvalidateDashboard();

  const [draft, setDraft] = useState<RiskDraft>(EMPTY_DRAFT);
  const [syncedAt, setSyncedAt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [clicked, setClicked] = useState<{
    n: PresetNumber;
    at: number;
  } | null>(null);

  // Settings refresh every 15 s. A load that arrives while the user is typing in the grid
  // is skipped (not applied later), so a half-typed number is never overwritten.
  if (s && dataUpdatedAt !== syncedAt) {
    setSyncedAt(dataUpdatedAt);
    if (!editing) setDraft((d) => draftFromSettings(s, d));
  }

  const save = useMutation({
    mutationFn: (d: RiskDraft) => dashboardApi.saveSettings(draftToUpdate(d)),
    onSuccess: (r) => {
      setNote({ text: '✅ บันทึกแล้ว (มีผลทันที)', at: dataUpdatedAt });
      log.append(
        'ตั้งค่าใหม่: เสี่ยง $' +
          r.risk_usd_per_trade +
          '/ไม้ · daily stop $' +
          r.daily_max_loss_usd +
          ' · ไม้ค้าง ' +
          r.max_open_positions,
        'warn',
      );
      invalidate('settings');
    },
    onError: (e) => {
      setNote({ text: '❌ ' + describeError(e), at: dataUpdatedAt });
    },
  });

  const applyPreset = (p: RiskPreset) => {
    const next = applyPresetToDraft(draft, p);
    setDraft(next);
    setClicked({ n: p.n, at: dataUpdatedAt });
    const warning = tinyPresetWarning(p);
    if (warning) log.append(warning, 'warn');
    log.append(
      'ใส่ชุดค่าแนะนำ #' + p.n + ' (' + p.name + ') — กำลังบันทึก…',
      'info',
    );
    save.mutate(next);
  };

  const activePreset =
    clicked?.at === dataUpdatedAt ? clicked.n : s ? matchPreset(s) : null;
  const shownNote = note?.at === dataUpdatedAt ? note.text : null;

  return (
    <div className="card">
      <h2>⚠️ ความเสี่ยงที่ยอมรับได้</h2>
      <div
        className="setgrid"
        onFocus={() => {
          setEditing(true);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setEditing(false);
        }}
      >
        {RISK_FIELDS.map((f) => (
          <div key={f.name}>
            <span className="lbl">
              {f.label} {'info' in f ? <InfoButton k={f.info} /> : null}
            </span>
            <input
              type="number"
              aria-label={f.label}
              step={f.step}
              min={f.min}
              max={'max' in f ? f.max : undefined}
              value={draft[f.name]}
              readOnly={!canOperate}
              onChange={(e) => {
                const v = e.target.value;
                setDraft((d) => ({ ...d, [f.name]: v }));
              }}
            />
          </div>
        ))}
      </div>

      <Can role="operator">
        <span className="lbl m12">
          ⚡ ใส่ค่าแนะนำทันที — เลือกตามยอดพอร์ต <InfoButton k="preset" />
        </span>
        <div className="presets">
          {PRESETS.map((p) => {
            const b = PRESET_BUTTONS[p.n];
            return (
              <button
                key={p.n}
                type="button"
                className={
                  'btn-preset' +
                  (b.tiny ? ' tiny' : '') +
                  (activePreset === p.n ? ' on' : '')
                }
                aria-pressed={activePreset === p.n}
                disabled={save.isPending}
                onClick={() => {
                  applyPreset(p);
                }}
              >
                <b>#{p.n}</b>
                <span>{b.label}</span>
                <em>{b.sub}</em>
              </button>
            );
          })}
        </div>
        <div className="tiny-warn">
          ⚠ ชุด #5/#6 เป็นทุนที่<b>เล็กเกินกว่าจะเทรดทองอย่างปลอดภัย</b> — lot
          ขั้นต่ำของ XAUUSD คือ 0.01 ซึ่งเสี่ยง $5–15/ไม้ตามระยะ SL จริง กดปุ่ม
          i เพื่อดูตัวเลข
        </div>
        <div className="row">
          <button
            type="button"
            className="btn-save"
            disabled={save.isPending}
            onClick={() => {
              save.mutate(draft);
            }}
          >
            💾 บันทึกค่าความเสี่ยง
          </button>
        </div>
      </Can>

      <div className="muted mt6" role="status">
        {shownNote ??
          (settings.isError ? (
            'โหลดค่าไม่ได้'
          ) : s ? (
            <SettingsNote s={s} />
          ) : null)}
      </div>
      <div className="info-row">
        <InfoButton k="sizing" variant="pill-lg">
          i · ขนาดไม้คำนวณยังไง
        </InfoButton>
        <InfoButton k="cooldown" variant="pill-lg">
          i · cooldown &amp; guard อื่น
        </InfoButton>
        <InfoButton k="preset" variant="pill-lg pill-green">
          ★ ชุดค่าที่แนะนำ
        </InfoButton>
      </div>
    </div>
  );
}

function SettingsNote({ s }: { s: BotSettings }) {
  return (
    <>
      {'sizing: ' +
        s.sizing +
        (s.overridden.length
          ? ' · แก้จากหน้าเว็บ ' + s.overridden.length + ' ค่า'
          : ' · ใช้ค่าจาก env')}
      {s.min_confidence > TA_MAX_CONFIDENCE ? (
        <>
          <br />
          <span className="c-red">
            ⚠ confidence {s.min_confidence} สูงกว่าเพดานจริง (
            {TA_MAX_CONFIDENCE}) — บอทจะไม่เปิดไม้เลย
          </span>
        </>
      ) : null}
    </>
  );
}
