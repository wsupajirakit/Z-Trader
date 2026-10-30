import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import LinearProgress from '@mui/material/LinearProgress';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Slider from '@mui/material/Slider';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type {
  AiGate,
  AiMode,
  AiStrictness,
  SettingsUpdate,
  ThinkingLevel,
} from '../../api/types';
import { LoadingState } from '../../components/States';
import { aiModelsQuery, settingsQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { capsLabel } from '../../theme/theme';
import { useCan } from '../auth/session';
import { DECISION_MODES, STRICTNESS } from './aiOptions';

const THINKING: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];
const THINKING_LABEL: Record<ThinkingLevel, string> = {
  minimal: 'Fast',
  low: 'Balanced',
  medium: 'Deep',
  high: 'Maximum',
};

const GATES: readonly { id: AiGate; label: string; detail: string }[] = [
  {
    id: 'setup_only',
    label: 'Setups only',
    detail: 'Ask the AI only when TA has a setup (fewest calls).',
  },
  {
    id: 'near_miss',
    label: 'Near misses',
    detail: 'Also ask when TA narrowly rejected a setup (recommended).',
  },
  {
    id: 'always',
    label: 'Every round',
    detail: 'Ask after every analysis round (most calls).',
  },
];

function Section({
  title,
  children,
  hint,
}: {
  title: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Box sx={{ mb: 4 }}>
      <Box
        sx={{ ...capsLabel, fontSize: 10, color: 'text.secondary', mb: 1.5 }}
      >
        {title}
      </Box>
      {children}
      {hint ? (
        <Box sx={{ color: 'text.secondary', fontSize: 11, mt: 1 }}>{hint}</Box>
      ) : null}
    </Box>
  );
}

/** decision mode, model, intelligence, strictness, when to ask, and the daily AI quota */
export function AiSettings() {
  const { data: s } = useQuery(settingsQuery);
  const models = useQuery(aiModelsQuery);
  const canOperate = useCan('operator');
  const save = useAction({
    fn: (body: SettingsUpdate) => dashboardApi.saveSettings(body),
    invalidate: [qk.dashboard.settings, qk.dashboard.aiModels],
    success: (_r, body) =>
      `AI settings saved: ${Object.entries(body)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ')}`,
    failure: (m) => `Could not save AI settings: ${m}`,
    tag: 'ai',
  });
  const reset = useAction({
    fn: () => dashboardApi.resetAiCalls(),
    invalidate: [qk.dashboard.settings],
    success: (r) => `AI quota reset (was ${r.reset_from} calls today)`,
    tag: 'ai',
  });
  if (!s) return <LoadingState />;

  const mode: AiMode = s.ai_mode_selected ?? s.ai_mode;
  const provider = s.ai_provider ?? 'gemini';
  const hasGemini = models.data?.has_gemini_key ?? s.ai.has_key;
  const hasClaude = models.data?.has_claude_key ?? s.claude?.has_key ?? false;
  const list = models.data?.models ?? [];
  const current =
    provider === 'claude'
      ? (models.data?.claude_current ?? s.claude?.model ?? '')
      : (models.data?.gemini_current ?? s.ai.model);
  const thinking = (
    THINKING.includes(s.ai.thinking_level as ThinkingLevel)
      ? s.ai.thinking_level
      : 'low'
  ) as ThinkingLevel;
  const strictness = s.ai_strictness ?? 'normal';
  const ro = !canOperate || save.isPending;
  const modeOk = (m: AiMode) =>
    m === 'off' || hasGemini || (m === 'ai_only' && hasClaude);
  const quota = s.ai_calls;

  return (
    <Box>
      {mode !== s.ai_mode ? (
        <Alert severity="warning" variant="outlined" sx={{ mb: 3 }}>
          {DECISION_MODES.find((d) => d.id === mode)?.label} is selected but the
          bot is running TA only — the{' '}
          {provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY'} is
          not set on the server.
        </Alert>
      ) : null}

      <Section title="Decision mode">
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 1.5,
          }}
          role="radiogroup"
          aria-label="Decision mode"
        >
          {DECISION_MODES.map((d) => {
            const selected = d.id === mode;
            const ok = modeOk(d.id);
            return (
              <Tooltip
                key={d.id}
                title={ok ? '' : 'Needs an AI API key on the server'}
              >
                <ButtonBase
                  role="radio"
                  aria-checked={selected}
                  disabled={ro || !ok}
                  onClick={() => {
                    if (!selected) save.mutate({ ai_mode: d.id });
                  }}
                  sx={{
                    display: 'block',
                    textAlign: 'left',
                    p: 2,
                    border: 1,
                    borderRadius: 0.5,
                    borderColor: selected ? 'primary.main' : 'divider',
                    bgcolor: selected ? 'action.selected' : 'transparent',
                    opacity: ok ? 1 : 0.45,
                    '&:hover': { borderColor: 'primary.main' },
                  }}
                >
                  <Box
                    sx={{
                      ...capsLabel,
                      fontSize: 11,
                      color: selected ? 'primary.main' : 'text.primary',
                    }}
                  >
                    {d.label}
                  </Box>
                  <Box
                    sx={{
                      fontSize: 11,
                      color: 'text.secondary',
                      mt: 0.5,
                      lineHeight: 1.45,
                    }}
                  >
                    {d.detail}
                  </Box>
                </ButtonBase>
              </Tooltip>
            );
          })}
        </Box>
      </Section>

      <Section
        title="Model"
        hint={
          mode === 'assist' || mode === 'lead'
            ? 'Confirm and lead modes run on Gemini. Claude models are available in AI only mode.'
            : models.data?.error
              ? `Model list: ${models.data.error}`
              : undefined
        }
      >
        <TextField
          select
          fullWidth
          label="AI model"
          value={list.some((m) => m.id === current) ? current : ''}
          disabled={ro || mode === 'off' || !list.length}
          onChange={(e) => {
            save.mutate({ ai_model: e.target.value });
          }}
          helperText={
            !list.length
              ? hasGemini || hasClaude
                ? 'Loading models…'
                : 'No AI key configured on the server'
              : undefined
          }
        >
          {(['gemini', 'claude'] as const).flatMap((p) => {
            const group = list.filter((m) => (m.provider ?? 'gemini') === p);
            if (!group.length) return [];
            return [
              <ListSubheader key={`h-${p}`}>
                {p === 'gemini' ? 'Google Gemini' : 'Anthropic Claude'}
              </ListSubheader>,
              ...group.map((m) => (
                <MenuItem
                  key={m.id}
                  value={m.id}
                  disabled={!!m.modes && !m.modes.includes(mode)}
                >
                  {m.label || m.id}
                  <Box
                    component="span"
                    sx={{ color: 'text.secondary', ml: 1, fontSize: 11 }}
                  >
                    {m.id}
                  </Box>
                </MenuItem>
              )),
            ];
          })}
        </TextField>
      </Section>

      <Section
        title="Intelligence"
        hint="How long the model thinks before answering. Deeper is slower and uses more tokens."
      >
        <Box sx={{ px: 2 }}>
          <Slider
            aria-label="Intelligence"
            value={THINKING.indexOf(thinking)}
            min={0}
            max={3}
            step={1}
            marks={THINKING.map((t, i) => ({
              value: i,
              label: THINKING_LABEL[t],
            }))}
            disabled={ro || mode === 'off'}
            onChangeCommitted={(_e, v) => {
              const level = THINKING[v];
              if (level && level !== thinking)
                save.mutate({ ai_thinking: level });
            }}
          />
        </Box>
      </Section>

      <Section
        title="Strictness"
        hint={STRICTNESS.find((x) => x.id === strictness)?.detail}
      >
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={strictness}
          disabled={ro || mode === 'off'}
          aria-label="Strictness"
          onChange={(_e, v: AiStrictness | null) => {
            if (v && v !== strictness) save.mutate({ ai_strictness: v });
          }}
        >
          {STRICTNESS.map((x) => (
            <ToggleButton key={x.id} value={x.id}>
              {x.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Section>

      {mode === 'assist' || mode === 'lead' ? (
        <Section
          title="When to ask the AI"
          hint={GATES.find((g) => g.id === s.ai_gate)?.detail}
        >
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={s.ai_gate}
            disabled={ro}
            aria-label="When to ask the AI"
            onChange={(_e, v: AiGate | null) => {
              if (v && v !== s.ai_gate) save.mutate({ ai_gate: v });
            }}
          >
            {GATES.map((g) => (
              <ToggleButton key={g.id} value={g.id}>
                {g.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Section>
      ) : null}

      <Section
        title="Daily AI quota"
        hint="Shared by every instrument. When it runs out the bot continues with TA only (AI-only mode stops trading) until the next UTC day."
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ flex: 1 }}>
            <LinearProgress
              variant="determinate"
              value={
                quota.max ? Math.min(100, (quota.used / quota.max) * 100) : 0
              }
              color={quota.remaining === 0 ? 'error' : 'primary'}
              aria-label="AI quota used"
            />
          </Box>
          <Box
            className="num"
            sx={{ fontSize: 12, minWidth: 80, textAlign: 'right' }}
          >
            {quota.used} / {quota.max || '∞'}
          </Box>
          {canOperate ? (
            <>
              <TextField
                type="number"
                label="Max / day"
                defaultValue={s.ai_max_calls_per_day}
                key={s.ai_max_calls_per_day}
                sx={{ width: 110 }}
                slotProps={{ htmlInput: { min: 0, max: 10000 } }}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v !== s.ai_max_calls_per_day)
                    save.mutate({ ai_max_calls_per_day: v });
                }}
              />
              <Button
                variant="outlined"
                disabled={reset.isPending}
                onClick={() => {
                  reset.mutate(undefined);
                }}
              >
                Reset
              </Button>
            </>
          ) : null}
        </Box>
      </Section>
    </Box>
  );
}
