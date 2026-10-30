import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setCsrfToken } from '../../api/client';
import { baseRoutes, riskProfiles, settings } from '../../test/fixtures';
import { stubFetch } from '../../test/fetchStub';
import { renderCard } from '../../test/renderWithProviders';
import { RiskProfiles } from './RiskProfiles';

describe('risk profiles', () => {
  it('apply shows before → after and posts with CSRF after confirmation', async () => {
    const calls = stubFetch({
      ...baseRoutes(),
      'POST /api/risk-profiles/builtin%3Amicro/apply': {
        profile: { id: 'builtin:micro', name: 'Micro account' },
        applied: {},
        settings: settings(),
      },
    });
    setCsrfToken('csrf-test-token');
    renderCard(<RiskProfiles />, 'operator');
    const user = userEvent.setup();
    const card = (
      await screen.findByText('Micro account')
    ).closest<HTMLElement>('.MuiPaper-root')!;
    await user.click(within(card).getByRole('button', { name: 'Apply' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Risk per trade')).toBeInTheDocument();
    expect(within(dialog).getByText('100')).toBeInTheDocument(); // before
    expect(within(dialog).getByText('10')).toBeInTheDocument(); // after
    await user.click(
      within(dialog).getByRole('button', { name: 'Apply profile' }),
    );
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.method === 'POST' &&
            c.url === '/api/risk-profiles/builtin%3Amicro/apply',
        ),
      ).toBe(true);
    });
    expect(
      calls.find((c) => c.url.endsWith('/apply'))?.headers.get('X-CSRF-Token'),
    ).toBe('csrf-test-token');
  });

  it('viewers see the profiles but no Apply / Save buttons', async () => {
    stubFetch(baseRoutes());
    renderCard(<RiskProfiles />, 'viewer');
    expect(await screen.findByText('Balanced')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Apply' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save current as profile' }),
    ).not.toBeInTheDocument();
  });

  it('a % profile shows the USD amount for the current balance', async () => {
    stubFetch(baseRoutes());
    renderCard(<RiskProfiles />, 'viewer');
    expect(await screen.findByText(/= \$100\.00/)).toBeInTheDocument();
    expect(riskProfiles.balance).toBe(10_000);
  });
});
