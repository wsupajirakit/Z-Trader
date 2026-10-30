import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import { useForm } from '@tanstack/react-form';
import type {
  AmountUnit,
  RiskProfileInput,
  RiskProfileValues,
} from '../../api/types';
import { capsLabel } from '../../theme/theme';
import { validateRange } from './riskFields';

const INSTRUMENTS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'] as const;
const AMOUNT_LIMITS: Record<
  'risk' | 'daily',
  Record<AmountUnit, { min: number; max: number }>
> = {
  risk: { usd: { min: 1, max: 100_000 }, pct: { min: 0.01, max: 10 } },
  daily: { usd: { min: 0, max: 1_000_000 }, pct: { min: 0, max: 50 } },
};
const INT_FIELDS = [
  {
    key: 'max_open_positions',
    label: 'Open trades / instrument',
    min: 1,
    max: 20,
  },
  {
    key: 'max_open_positions_total',
    label: 'Open trades total (0 = no cap)',
    min: 0,
    max: 200,
  },
  { key: 'min_confidence', label: 'Min confidence (0–8)', min: 0, max: 8 },
  {
    key: 'loss_cooldown_bars',
    label: 'Loss cooldown (bars)',
    min: 0,
    max: 100,
  },
  { key: 'scalp_max_per_day', label: 'Scalps / day', min: 1, max: 50 },
] as const;

interface FormValues {
  name: string;
  description: string;
  riskUnit: AmountUnit;
  risk: number;
  dailyUnit: AmountUnit;
  daily: number;
  max_open_positions: number;
  max_open_positions_total: number;
  min_confidence: number;
  loss_cooldown_bars: number;
  scalp_max_per_day: number;
  lots: Record<string, string>;
}

function toForm(p: {
  name: string;
  description: string;
  values: RiskProfileValues;
}): FormValues {
  const v = p.values;
  return {
    name: p.name,
    description: p.description,
    riskUnit: v.risk_per_trade.unit,
    risk: v.risk_per_trade.value,
    dailyUnit: v.daily_max_loss.unit,
    daily: v.daily_max_loss.value,
    max_open_positions: v.max_open_positions,
    max_open_positions_total: v.max_open_positions_total,
    min_confidence: v.min_confidence,
    loss_cooldown_bars: v.loss_cooldown_bars,
    scalp_max_per_day: v.scalp_max_per_day,
    lots: Object.fromEntries(
      INSTRUMENTS.map((k) => [
        k,
        v.max_lot?.[k] != null ? String(v.max_lot[k]) : '',
      ]),
    ),
  };
}

function fromForm(f: FormValues): RiskProfileInput {
  const lots = Object.fromEntries(
    Object.entries(f.lots)
      .filter(([, v]) => v.trim() !== '')
      .map(([k, v]) => [k, Number(v)]),
  );
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    values: {
      risk_per_trade: { unit: f.riskUnit, value: f.risk },
      daily_max_loss: { unit: f.dailyUnit, value: f.daily },
      max_open_positions: f.max_open_positions,
      max_open_positions_total: f.max_open_positions_total,
      min_confidence: f.min_confidence,
      loss_cooldown_bars: f.loss_cooldown_bars,
      scalp_max_per_day: f.scalp_max_per_day,
      ...(Object.keys(lots).length ? { max_lot: lots } : {}),
    },
  };
}

const num = (v: string) => (v === '' ? Number.NaN : Number(v));

/** create / edit a saved risk profile; risk and daily stop in USD or % of the balance */
export function ProfileEditorDialog({
  open,
  title,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: { name: string; description: string; values: RiskProfileValues };
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: RiskProfileInput) => void;
}) {
  const form = useForm({
    defaultValues: toForm(initial),
    onSubmit: ({ value }) => {
      onSubmit(fromForm(value));
    },
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <Box
        component="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            <form.Field
              name="name"
              validators={{
                onChange: ({ value }) =>
                  value.trim().length < 1 || value.length > 40
                    ? '1–40 characters'
                    : undefined,
              }}
            >
              {(field) => (
                <TextField
                  autoFocus
                  label="Name"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                  }}
                  error={field.state.meta.errors.length > 0}
                  helperText={field.state.meta.errors[0]}
                  sx={{ gridColumn: '1 / -1' }}
                />
              )}
            </form.Field>
            <form.Field name="description">
              {(field) => (
                <TextField
                  label="Description"
                  value={field.state.value}
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                  }}
                  slotProps={{ htmlInput: { maxLength: 200 } }}
                  sx={{ gridColumn: '1 / -1' }}
                />
              )}
            </form.Field>
            {(
              [
                ['risk', 'riskUnit', 'Risk per trade'],
                ['daily', 'dailyUnit', 'Daily stop'],
              ] as const
            ).map(([valueKey, unitKey, label]) => (
              <Box key={valueKey} sx={{ display: 'flex', gap: 1 }}>
                <form.Subscribe selector={(st) => st.values[unitKey]}>
                  {(unit) => (
                    <form.Field
                      name={valueKey}
                      validators={{
                        onChangeListenTo: [unitKey],
                        onChange: ({ value }) =>
                          validateRange(value, AMOUNT_LIMITS[valueKey][unit]),
                      }}
                    >
                      {(field) => (
                        <TextField
                          type="number"
                          label={label}
                          value={
                            Number.isNaN(field.state.value)
                              ? ''
                              : field.state.value
                          }
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(num(e.target.value));
                          }}
                          error={field.state.meta.errors.length > 0}
                          helperText={
                            field.state.meta.errors[0] ??
                            (unit === 'pct'
                              ? '% of the account balance'
                              : 'US dollars')
                          }
                          sx={{ flex: 1 }}
                        />
                      )}
                    </form.Field>
                  )}
                </form.Subscribe>
                <form.Field name={unitKey}>
                  {(field) => (
                    <TextField
                      select
                      label="Unit"
                      value={field.state.value}
                      onChange={(e) => {
                        field.handleChange(e.target.value as AmountUnit);
                      }}
                      sx={{ width: 84 }}
                    >
                      <MenuItem value="usd">USD</MenuItem>
                      <MenuItem value="pct">%</MenuItem>
                    </TextField>
                  )}
                </form.Field>
              </Box>
            ))}
            {INT_FIELDS.map((f) => (
              <form.Field
                key={f.key}
                name={f.key}
                validators={{
                  onChange: ({ value }) =>
                    validateRange(value, f) ??
                    (Number.isInteger(value) ? undefined : 'Whole number'),
                }}
              >
                {(field) => (
                  <TextField
                    type="number"
                    label={f.label}
                    value={
                      Number.isNaN(field.state.value) ? '' : field.state.value
                    }
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      field.handleChange(num(e.target.value));
                    }}
                    error={field.state.meta.errors.length > 0}
                    helperText={field.state.meta.errors[0]}
                  />
                )}
              </form.Field>
            ))}
          </Box>
          <Box
            sx={{
              ...capsLabel,
              fontSize: 10,
              color: 'text.secondary',
              mt: 3,
              mb: 1,
            }}
          >
            Lot caps (empty = leave unchanged)
          </Box>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 2,
            }}
          >
            {INSTRUMENTS.map((k) => (
              <form.Field
                key={k}
                name={`lots.${k}`}
                validators={{
                  onChange: ({ value }) =>
                    value.trim() === ''
                      ? undefined
                      : validateRange(Number(value), { min: 0.01, max: 100 }),
                }}
              >
                {(field) => (
                  <TextField
                    type="number"
                    label={k}
                    value={field.state.value}
                    onChange={(e) => {
                      field.handleChange(e.target.value);
                    }}
                    error={field.state.meta.errors.length > 0}
                    helperText={field.state.meta.errors[0]}
                    slotProps={{ htmlInput: { step: 0.01, min: 0.01 } }}
                  />
                )}
              </form.Field>
            ))}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={onClose}>
            Cancel
          </Button>
          <form.Subscribe selector={(st) => st.canSubmit}>
            {(canSubmit) => (
              <Button
                type="submit"
                variant="contained"
                disabled={!canSubmit || busy}
              >
                Save profile
              </Button>
            )}
          </form.Subscribe>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
