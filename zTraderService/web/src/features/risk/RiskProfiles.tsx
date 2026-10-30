import Add from '@mui/icons-material/Add';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { qk } from '../../api/queryKeys';
import { riskProfilesApi } from '../../api/terminal';
import type {
  BotSettings,
  RiskProfile,
  RiskProfileInput,
  RiskProfileValues,
} from '../../api/types';
import { useDialogs } from '../../components/dialogs/context';
import { ErrorState, LoadingState } from '../../components/States';
import { riskProfilesQuery, settingsQuery } from '../../data/queries';
import { useAction } from '../../data/useAction';
import { usd } from '../../lib/format';
import { capsLabel } from '../../theme/theme';
import { useCan, useCurrentUser } from '../auth/session';
import { hasRole } from '../auth/roles';
import { ProfileEditorDialog } from './ProfileEditorDialog';
import { SETTING_LABEL } from './riskFields';

const amount = (a: { unit: 'usd' | 'pct'; value: number }) =>
  a.unit === 'pct' ? `${a.value}%` : usd(a.value, a.value % 1 ? 2 : 0);

function currentAsValues(s: BotSettings): RiskProfileValues {
  return {
    risk_per_trade: { unit: 'usd', value: s.risk_usd_per_trade },
    daily_max_loss: { unit: 'usd', value: s.daily_max_loss_usd },
    max_open_positions: s.max_open_positions,
    max_open_positions_total: s.max_open_positions_total,
    min_confidence: s.min_confidence,
    loss_cooldown_bars: s.loss_cooldown_bars,
    scalp_max_per_day: s.scalp_max_per_day,
    max_lot: { ...s.max_lot_by_instrument },
  };
}

function settingValue(
  s: BotSettings | undefined,
  key: string,
): number | undefined {
  if (!s) return undefined;
  if (key.startsWith('max_lot_'))
    return s.max_lot_by_instrument[key.slice(8).toUpperCase()];
  const v = (s as unknown as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Risk profiles: built-in and saved sets of risk limits. Apply shows the before → after values
 * for the current balance and sets them all at once (audited); operators save their own.
 */
export function RiskProfiles({ compact = false }: { compact?: boolean }) {
  const q = useQuery(riskProfilesQuery);
  const { data: s } = useQuery(settingsQuery);
  const canOperate = useCan('operator');
  const user = useCurrentUser();
  const dialogs = useDialogs();
  const [editing, setEditing] = useState<{
    profile: RiskProfile | null;
    initial: { name: string; description: string; values: RiskProfileValues };
  } | null>(null);
  const invalidate = [qk.riskProfiles, qk.dashboard.settings];

  const apply = useAction({
    fn: (p: RiskProfile) => riskProfilesApi.apply(p.id),
    invalidate,
    success: (r) => `Risk profile applied: ${r.profile.name}`,
    failure: (m, p) => `Could not apply ${p.name}: ${m}`,
    tag: 'risk',
  });
  const create = useAction({
    fn: (input: RiskProfileInput) => riskProfilesApi.create(input),
    invalidate,
    success: (r) => `Risk profile saved: ${r.name}`,
    failure: (m) => `Could not save the profile: ${m}`,
    tag: 'risk',
    onSuccess: () => {
      setEditing(null);
    },
  });
  const update = useAction({
    fn: (v: { id: string; input: RiskProfileInput }) =>
      riskProfilesApi.update(v.id, v.input),
    invalidate,
    success: (r) => `Risk profile updated: ${r.name}`,
    failure: (m) => `Could not update the profile: ${m}`,
    tag: 'risk',
    onSuccess: () => {
      setEditing(null);
    },
  });
  const remove = useAction({
    fn: (p: RiskProfile) => riskProfilesApi.remove(p.id),
    invalidate,
    success: (_r, p) => `Risk profile deleted: ${p.name}`,
    failure: (m) => `Could not delete the profile: ${m}`,
    tag: 'risk',
  });

  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { profiles, active, balance } = q.data;

  const confirmApply = async (p: RiskProfile) => {
    if (!p.resolved) return;
    const rows = Object.entries(p.resolved);
    const ok = await dialogs.confirm({
      title: `Apply “${p.name}”`,
      message: (
        <>
          These risk limits will replace the current ones at once
          {s?.risk_profile?.modified
            ? ' (your manual changes are overwritten)'
            : ''}
          .
        </>
      ),
      details: (
        <Box
          component="table"
          sx={{
            width: '100%',
            fontSize: 12,
            borderCollapse: 'collapse',
            '& td': { py: 0.5, borderBottom: 1, borderColor: 'divider' },
          }}
        >
          <tbody>
            {rows.map(([k, v]) => {
              const before = settingValue(s, k);
              const changed = before !== undefined && before !== v;
              return (
                <tr key={k}>
                  <Box component="td" sx={{ color: 'text.secondary' }}>
                    {SETTING_LABEL[k] ?? k}
                  </Box>
                  <Box
                    component="td"
                    className="num"
                    sx={{ textAlign: 'right', color: 'text.secondary' }}
                  >
                    {before ?? '—'}
                  </Box>
                  <Box
                    component="td"
                    sx={{ textAlign: 'center', color: 'text.disabled' }}
                  >
                    →
                  </Box>
                  <Box
                    component="td"
                    className="num"
                    sx={{
                      textAlign: 'right',
                      fontWeight: 700,
                      color: changed ? 'primary.main' : undefined,
                    }}
                  >
                    {v}
                  </Box>
                </tr>
              );
            })}
          </tbody>
        </Box>
      ),
      confirmLabel: 'Apply profile',
    });
    if (ok) apply.mutate(p);
  };

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          mb: 2,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ fontSize: 11.5, color: 'text.secondary' }}>
          Balance{' '}
          <b className="num">
            {balance != null ? usd(balance) : 'unavailable'}
          </b>
          {active ? (
            <>
              {' '}
              · active <b>{active.name}</b>
              {active.modified ? (
                <Box component="span" sx={{ color: 'warning.main' }}>
                  {' '}
                  (modified:{' '}
                  {active.changed.map((k) => SETTING_LABEL[k] ?? k).join(', ')})
                </Box>
              ) : null}
            </>
          ) : null}
        </Box>
        <Box sx={{ flex: 1 }} />
        {canOperate && s ? (
          <Button
            startIcon={<Add />}
            variant="outlined"
            onClick={() => {
              setEditing({
                profile: null,
                initial: {
                  name: '',
                  description: '',
                  values: currentAsValues(s),
                },
              });
            }}
          >
            Save current as profile
          </Button>
        ) : null}
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: compact
            ? '1fr'
            : 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 2,
        }}
      >
        {profiles.map((p) => {
          const isActive = active?.id === p.id;
          const v = p.values;
          return (
            <Paper
              key={p.id}
              sx={{
                p: 2,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                borderColor: isActive ? 'primary.main' : undefined,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    ...capsLabel,
                    fontSize: 11.5,
                    color: isActive ? 'primary.main' : 'text.primary',
                    flex: 1,
                  }}
                >
                  {p.name}
                </Box>
                {p.builtIn ? (
                  <Chip label="built-in" variant="outlined" />
                ) : (
                  <Chip label={p.createdBy ?? 'saved'} variant="outlined" />
                )}
                {isActive ? (
                  <Chip
                    color="primary"
                    label={active.modified ? 'active *' : 'active'}
                  />
                ) : null}
              </Box>
              {p.description ? (
                <Box
                  sx={{ fontSize: 11, color: 'text.secondary', minHeight: 30 }}
                >
                  {p.description}
                </Box>
              ) : null}
              <Box
                className="num"
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '2px 10px',
                  fontSize: 11.5,
                }}
              >
                <Box sx={{ color: 'text.secondary' }}>Risk / trade</Box>
                <span>
                  {amount(v.risk_per_trade)}
                  {v.risk_per_trade.unit === 'pct' && p.resolved ? (
                    <Box component="span" sx={{ color: 'text.secondary' }}>
                      {' '}
                      = {usd(p.resolved.risk_usd_per_trade ?? null)}
                    </Box>
                  ) : null}
                </span>
                <Box sx={{ color: 'text.secondary' }}>Daily stop</Box>
                <span>
                  {amount(v.daily_max_loss)}
                  {v.daily_max_loss.unit === 'pct' && p.resolved ? (
                    <Box component="span" sx={{ color: 'text.secondary' }}>
                      {' '}
                      = {usd(p.resolved.daily_max_loss_usd ?? null)}
                    </Box>
                  ) : null}
                </span>
                <Box sx={{ color: 'text.secondary' }}>Open trades</Box>
                <span>
                  {v.max_open_positions} / {v.max_open_positions_total || '∞'}
                </span>
                <Box sx={{ color: 'text.secondary' }}>Min confidence</Box>
                <span>{v.min_confidence}</span>
                <Box sx={{ color: 'text.secondary' }}>Cooldown · scalps</Box>
                <span>
                  {v.loss_cooldown_bars} bars · {v.scalp_max_per_day}/day
                </span>
                {v.max_lot && Object.keys(v.max_lot).length ? (
                  <>
                    <Box sx={{ color: 'text.secondary' }}>Lot caps</Box>
                    <span>
                      {Object.entries(v.max_lot)
                        .map(([k, n]) => `${k} ${String(n)}`)
                        .join(' · ')}
                    </span>
                  </>
                ) : null}
              </Box>
              {canOperate ? (
                <Box sx={{ display: 'flex', gap: 1, mt: 'auto', pt: 1 }}>
                  <Tooltip
                    title={
                      p.resolved
                        ? ''
                        : 'Needs the account balance (cTrader not connected)'
                    }
                  >
                    <span>
                      <Button
                        size="small"
                        variant={isActive ? 'outlined' : 'contained'}
                        disabled={!p.resolved || apply.isPending}
                        onClick={() => void confirmApply(p)}
                      >
                        {isActive ? 'Re-apply' : 'Apply'}
                      </Button>
                    </span>
                  </Tooltip>
                  {!p.builtIn ? (
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() => {
                        setEditing({
                          profile: p,
                          initial: {
                            name: p.name,
                            description: p.description,
                            values: p.values,
                          },
                        });
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {!p.builtIn && hasRole(user?.role, 'admin') ? (
                    <Button
                      size="small"
                      color="error"
                      onClick={async () => {
                        const ok = await dialogs.confirm({
                          title: 'Delete risk profile',
                          message: `Delete “${p.name}”? The current risk settings stay as they are.`,
                          confirmLabel: 'Delete',
                          tone: 'danger',
                        });
                        if (ok) remove.mutate(p);
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                </Box>
              ) : null}
            </Paper>
          );
        })}
      </Box>
      {editing ? (
        <ProfileEditorDialog
          open
          title={
            editing.profile
              ? `Edit “${editing.profile.name}”`
              : 'New risk profile'
          }
          initial={editing.initial}
          busy={create.isPending || update.isPending}
          onClose={() => {
            setEditing(null);
          }}
          onSubmit={(input) => {
            if (editing.profile)
              update.mutate({ id: editing.profile.id, input });
            else create.mutate(input);
          }}
        />
      ) : null}
    </Box>
  );
}
