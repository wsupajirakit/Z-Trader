import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../../api/dashboard';
import { qk } from '../../api/queryKeys';
import type { BotSettings, RiskSettingsUpdate } from '../../api/types';
import { LoadingState } from '../../components/States';
import { settingsQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { useCan } from '../auth/session';
import { changedFields, RISK_FIELDS, validateRange } from './riskFields';

function valuesOf(s: BotSettings): Record<string, number> {
  return Object.fromEntries(RISK_FIELDS.map((f) => [f.key, f.read(s)]));
}

/** every risk limit, editable one by one (TanStack Form, validated against the server ranges) */
export function RiskSettingsForm() {
  const { data: s } = useQuery(settingsQuery);
  if (!s) return <LoadingState />;
  // remount with fresh defaults when the server values change (another tab, a profile apply)
  return <Form key={JSON.stringify(valuesOf(s))} s={s} />;
}

function Form({ s }: { s: BotSettings }) {
  const canOperate = useCan('operator');
  const save = useAction({
    fn: (body: RiskSettingsUpdate) => dashboardApi.saveSettings(body),
    invalidate: [qk.dashboard.settings, qk.riskProfiles],
    success: (_r, body) =>
      `Risk settings saved: ${Object.entries(body)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ')}`,
    failure: (m) => `Could not save risk settings: ${m}`,
    tag: 'risk',
  });
  const form = useForm({
    defaultValues: valuesOf(s),
    onSubmit: ({ value }) => {
      const body = changedFields(value, s);
      if (Object.keys(body).length) save.mutate(body);
    },
  });

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 2,
        }}
      >
        {RISK_FIELDS.map((f) => (
          <form.Field
            key={f.key}
            name={f.key}
            validators={{ onChange: ({ value }) => validateRange(value, f) }}
          >
            {(field) => (
              <TextField
                type="number"
                label={f.label}
                value={field.state.value}
                disabled={!canOperate}
                onBlur={field.handleBlur}
                onChange={(e) => {
                  field.handleChange(
                    e.target.value === '' ? Number.NaN : Number(e.target.value),
                  );
                }}
                error={field.state.meta.errors.length > 0}
                helperText={
                  field.state.meta.errors.length
                    ? String(field.state.meta.errors[0])
                    : f.help
                }
                slotProps={{
                  htmlInput: {
                    min: f.min,
                    max: f.max,
                    step: f.step,
                    'aria-label': f.label,
                  },
                  input: f.unit
                    ? {
                        endAdornment: (
                          <InputAdornment position="end">
                            {f.unit}
                          </InputAdornment>
                        ),
                      }
                    : undefined,
                }}
              />
            )}
          </form.Field>
        ))}
      </Box>
      {canOperate ? (
        <form.Subscribe selector={(st) => [st.canSubmit, st.isDirty] as const}>
          {([canSubmit, dirty]) => (
            <Box
              sx={{
                display: 'flex',
                gap: 2,
                mt: 3,
                justifyContent: 'flex-end',
              }}
            >
              <Button
                disabled={!dirty}
                onClick={() => {
                  form.reset();
                }}
              >
                Discard
              </Button>
              <Button
                type="submit"
                variant="contained"
                disabled={!canSubmit || !dirty || save.isPending}
              >
                Save risk settings
              </Button>
            </Box>
          )}
        </form.Subscribe>
      ) : null}
    </Box>
  );
}
