import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, describeError } from '../../../api/client';
import { dashboardApi } from '../../../api/dashboard';
import type {
  AiGate,
  AiMode,
  BotSettings,
  ThinkingLevel,
} from '../../../api/types';
import { Can } from '../../auth/Can';
import { useCan } from '../../auth/session';
import { useActivityLog } from '../activity/ActivityLogContext';
import { InfoButton } from '../info/InfoButton';
import { aiModelsQuery, settingsQuery } from '../queries';
import { useInvalidateDashboard } from '../useInvalidateDashboard';
import {
  AI_GATES,
  AI_MODES,
  aiModeChangedLog,
  quotaView,
  THINK_LEVELS,
} from './ai';
import { KillSwitch } from './KillSwitch';
import { useSettingsMutation } from './useSettingsMutation';

/**
 * 🤖 AI box: role (off / assist / lead), when to ask (gate), daily quota, Gemini model and
 * thinking level, effective config, and the daily-stop kill switch. Switches apply at once.
 */
export function AiPanel() {
  const { data: s } = useQuery(settingsQuery);
  const canOperate = useCan('operator');
  const log = useActivityLog();
  const hasKey = !!s?.ai.has_key;
  const mode = s?.ai_mode;
  const gate = s?.ai_gate ?? 'near_miss';
  const thinking = (s?.ai.thinking_level ?? '').toLowerCase();

  const setMode = useSettingsMutation<AiMode>({
    toBody: (ai_mode) => ({ ai_mode }),
    onOk: (m) => {
      const { message, level } = aiModeChangedLog(m);
      log.append(message, level);
    },
    onFail: (_, msg) => {
      log.append('เปลี่ยนบทบาท AI ไม่สำเร็จ: ' + msg, 'error');
    },
  });
  const setGate = useSettingsMutation<AiGate>({
    toBody: (ai_gate) => ({ ai_gate }),
    onOk: (g) => {
      log.append('🚪 ประตู AI → ' + g, 'info');
    },
    onFail: (_, msg) => {
      log.append('เปลี่ยนประตู AI ไม่สำเร็จ: ' + msg, 'error');
    },
  });
  const setModel = useSettingsMutation<string>({
    toBody: (ai_model) => ({ ai_model }),
    onOk: (m) => {
      log.append('🧠 เปลี่ยนรุ่น Gemini → ' + m, 'info');
    },
    onFail: (_, msg) => {
      log.append('❌ เปลี่ยนรุ่นไม่สำเร็จ: ' + msg, 'error');
    },
  });
  const setThinking = useSettingsMutation<ThinkingLevel>({
    toBody: (ai_thinking) => ({ ai_thinking }),
    onOk: (v) => {
      log.append('🧠 ระดับการคิด → ' + v, 'info');
    },
    onFail: (_, msg) => {
      log.append('❌ ตั้งระดับการคิดไม่สำเร็จ: ' + msg, 'error');
    },
  });

  // Without GEMINI_API_KEY only "off" stays clickable (gate/thinking buttons too, as before).
  const aiLocked = !hasKey || !canOperate;

  return (
    <div className="aibox">
      <span className="lbl m0">
        <b className="title">🤖 บทบาทของ AI</b> <InfoButton k="aimode" />
      </span>
      <div className="aimodes" role="group" aria-label="บทบาทของ AI">
        {AI_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            className={'btn-aimode' + (mode === m.value ? ' on' : '')}
            aria-pressed={mode === m.value}
            disabled={!canOperate || (!hasKey && m.value !== 'off')}
            onClick={() => {
              setMode.mutate(m.value);
            }}
          >
            <b>{m.th}</b>
            <em>{m.sub}</em>
          </button>
        ))}
      </div>
      <div className="ai-note">{mode ? <AiModeNote mode={mode} /> : null}</div>

      <span className="lbl m12">
        🚪 ถาม AI ตอนไหน <InfoButton k="aigate" />
      </span>
      <div className="aimodes" role="group" aria-label="ถาม AI ตอนไหน">
        {AI_GATES.map((g) => (
          <button
            key={g.value}
            type="button"
            className={'btn-aimode' + (s && gate === g.value ? ' on' : '')}
            aria-pressed={!!s && gate === g.value}
            disabled={aiLocked}
            onClick={() => {
              setGate.mutate(g.value);
            }}
          >
            <b>{g.th}</b>
            <em>{g.sub}</em>
          </button>
        ))}
      </div>
      <div className="ai-note gate">
        {s ? <AiGateNote gate={gate} /> : null}
      </div>

      <AiQuota settings={s} />

      <span className="lbl m12">
        🧠 รุ่น Gemini + ระดับการคิด <InfoButton k="aimodel" />
      </span>
      <AiModelSelect
        current={s?.ai.model}
        disabled={!canOperate}
        onPick={(m) => {
          setModel.mutate(m);
        }}
      />
      <div className="checks think" role="group" aria-label="ระดับการคิด">
        {THINK_LEVELS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={
              'btn-aimode btn-think' + (thinking === t.value ? ' on' : '')
            }
            aria-pressed={thinking === t.value}
            disabled={aiLocked}
            onClick={() => {
              setThinking.mutate(t.value);
            }}
          >
            {t.th}
            <br />
            <span className="think-key">{t.value}</span>
          </button>
        ))}
      </div>
      <div className="ai-note think">
        {THINK_LEVELS.find((t) => t.value === thinking)?.note ?? ''}
      </div>

      <div className="ai-cfg">{s ? <AiConfig settings={s} /> : null}</div>

      <KillSwitch settings={s} />
    </div>
  );
}

function AiModeNote({ mode }: { mode: AiMode }) {
  if (mode === 'lead') {
    return (
      <>
        ⚠ โหมดนี้ AI เปิดไม้เองได้เมื่อ TA ไม่เจอ setup — ไม้ที่ AI
        หาเองถูกจำกัด <b>ขนาดไม่เกินครึ่ง</b>{' '}
        และต้องผ่านด่านความเสี่ยงทุกด่านเหมือนไม้ปกติ (R:R · SL เทียบ ATR ·
        เลขกลม · งบต่อไม้ · daily stop)
      </>
    );
  }
  if (mode === 'assist') {
    return (
      <>
        AI ตรวจเฉพาะไม้ที่ TA หามาได้ — ปัดตกได้ ขยับระดับได้{' '}
        <b>แต่เพิ่มความเสี่ยงไม่ได้</b> (ยก confidence ไม่ได้ ·
        เพิ่มขนาดไม้ไม่ได้ · บีบ SL ไม่ได้)
      </>
    );
  }
  return <>ใช้กฎ TA ล้วน ไม่เรียก AI เลย</>;
}

function AiGateNote({ gate }: { gate: AiGate }) {
  if (gate === 'setup_only') {
    return (
      <>
        ถาม AI <b>เฉพาะตอน TA เจอ setup แล้ว</b> — AI เป็นผู้ตรวจอย่างเดียว
        ประหยัดสุด แต่พลาดรอบที่ TA ปัดตกเพราะกฎแข็ง
      </>
    );
  }
  if (gate === 'always') {
    return (
      <span className="c-amber">
        ถาม AI <b>ทุกรอบที่วิเคราะห์จบ</b> — รวมรอบที่ไม่มี setup เลย (53%
        ของรอบ) เปลืองโควตาโดยไม่ได้อะไร
      </span>
    );
  }
  return (
    <>
      ถาม AI ตอน TA เจอ setup <b>+ ตอน NO_TRADE ที่ &quot;เฉียด&quot;</b>{' '}
      (โครงสร้างมีแต่ตกเกณฑ์ข้อเดียว เช่น RVOL 1.18 vs 1.2 · รอแท่งยืนยัน · SL
      กว้างไปนิด)
      <br />
      ตัดรอบที่ไม่มี setup เลยทิ้ง — ตรงกับที่งานวิจัยใช้ (Critical Decision
      Detector)
    </>
  );
}

/** AI quota of the UTC day — when it is used up the bot falls back to pure TA, it does not stop. */
function AiQuota({ settings }: { settings: BotSettings | undefined }) {
  const log = useActivityLog();
  const invalidate = useInvalidateDashboard();
  const reset = useMutation({
    mutationFn: dashboardApi.resetAiCalls,
    onSuccess: (d) => {
      log.append(
        '🔄 รีเซ็ตโควตา AI แล้ว (เดิมใช้ไป ' +
          String(d.reset_from) +
          ' ครั้ง) — กลับมาใช้ AI ได้ตามปกติ',
        'order',
      );
      invalidate('settings');
    },
    onError: (e) => {
      log.append('รีเซ็ตโควตา AI ไม่สำเร็จ: ' + describeError(e), 'error');
    },
  });
  const q = settings ? quotaView(settings) : null;

  return (
    <div className="quota">
      <div className="quota-head">
        <span>
          โควตา AI วันนี้ <b>{q?.text ?? '—'}</b>
        </span>
        <Can role="operator">
          <button
            type="button"
            className="btn-reset"
            disabled={reset.isPending}
            onClick={() => {
              reset.mutate();
            }}
          >
            🔄 รีเซ็ต
          </button>
        </Can>
      </div>
      <div className="quota-bar">
        <div className={q?.barClass} style={{ width: `${q?.pct ?? 0}%` }} />
      </div>
      <div className="quota-note">
        {q ? (
          q.full ? (
            <span className="c-amber">
              ⚠ เต็มแล้ว — บอท<b>สลับไปใช้ TA ล้วนอัตโนมัติ</b> ยังเทรดต่อปกติ ·
              กลับมาใช้ AI เองเมื่อข้ามวัน (UTC) หรือกดรีเซ็ต
            </span>
          ) : (
            'นับตามวัน UTC (' +
            q.dateUtc +
            ') · เต็มแล้วสลับเป็น TA ล้วนเอง ไม่หยุดเทรด · ตั้งจำนวนได้ที่ช่อง "AI ยิงสูงสุด/วัน"'
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * Model list straight from Google's ListModels (cached an hour server-side). It heals itself:
 * while empty or failed it is fetched again (see aiModelsQuery).
 */
function AiModelSelect({
  current,
  disabled,
  onPick,
}: {
  current: string | undefined;
  disabled: boolean;
  onPick: (model: string) => void;
}) {
  const { data, error } = useQuery(aiModelsQuery);

  if (error && !data?.models.length) {
    const why =
      error instanceof ApiError ? `HTTP ${error.status}` : describeError(error);
    return (
      <select aria-label="รุ่น Gemini" disabled value="">
        <option value="">โหลดรุ่นไม่ได้ ({why}) — จะลองใหม่เอง</option>
      </select>
    );
  }
  if (data && !data.models.length) {
    return (
      <select aria-label="รุ่น Gemini" disabled value="">
        <option value="">
          {data.error
            ? 'โหลดรุ่นไม่ได้: ' + data.error
            : 'ไม่มีรุ่นให้เลือก (ตั้ง GEMINI_API_KEY ก่อน)'}
        </option>
      </select>
    );
  }

  const models = data?.models ?? [];
  const has = (id: string | undefined) =>
    !!id && models.some((m) => m.id === id);
  const value = has(current)
    ? current
    : has(data?.current)
      ? data?.current
      : models[0]?.id;

  return (
    <select
      aria-label="รุ่น Gemini"
      value={value ?? ''}
      disabled={disabled || !data}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
          {m.label ? ' · ' + m.label : ''}
        </option>
      ))}
    </select>
  );
}

function AiConfig({ settings }: { settings: BotSettings }) {
  const a = settings.ai;
  if (!a.has_key) {
    return (
      <span className="c-red">
        ⚠ ยังไม่ได้ตั้ง GEMINI_API_KEY ใน env — เปิดโหมด AI ไม่ได้
      </span>
    );
  }
  return (
    <>
      รุ่น <b>{a.model}</b> · api <b>{a.api || 'generateContent'}</b> · คิดระดับ{' '}
      <b>{a.thinking_level || '-'}</b> · temp {a.temperature} · topK {a.top_k} ·
      topP {a.top_p}
      <br />
      แก้ค่าพวกนี้ได้ที่ env (GOLD_AI_MODEL, GOLD_AI_THINKING,
      GOLD_AI_TEMPERATURE, GOLD_AI_TOP_K, GOLD_AI_TOP_P)
    </>
  );
}
