import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { qk } from '../../../api/queryKeys';
import { stubFetch } from '../../../test/fetchStub';
import { settings } from '../../../test/fixtures';
import { renderCard } from '../../../test/renderWithProviders';
import { RiskSettingsCard } from './RiskSettingsCard';

describe('RiskSettingsCard', () => {
  it('a preset fills the six fields, saves them as numbers and logs the tiny-account warning', async () => {
    const calls = stubFetch({
      'GET /api/dashboard/settings': settings(),
      'POST /api/dashboard/settings': settings({
        risk_usd_per_trade: 10,
        daily_max_loss_usd: 20,
        max_open_positions: 1,
      }),
    });
    renderCard(<RiskSettingsCard />);
    const risk = screen.getByLabelText('เสี่ยงต่อไม้ ($)');
    await waitFor(() => {
      expect(risk).toHaveValue(100);
    });
    expect(screen.getByRole('button', { name: /#1/ })).toHaveClass('on');

    await userEvent.click(screen.getByRole('button', { name: /#5/ }));

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      risk_usd_per_trade: 10,
      daily_max_loss_usd: 20,
      max_open_positions: 1,
      max_open_positions_total: 0,
      scalp_max_per_day: 3,
      min_confidence: 8,
      max_lot: 0.01,
      max_lot_eurusd: 2,
      max_lot_gbpusd: 2,
      max_lot_usdjpy: 2,
      ai_max_calls_per_day: 10,
    });
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent(
      '⚠ ชุด #5 (ทุน $50) — lot 0.01 เสี่ยงจริง ~$9.6/ไม้ = 19%',
    );
    expect(log).toHaveTextContent('ใส่ชุดค่าแนะนำ #5 (ทุน $50) — กำลังบันทึก…');
    expect(
      await screen.findByText(
        /ตั้งค่าใหม่: เสี่ยง \$10\/ไม้ · daily stop \$20/,
      ),
    ).toBeInTheDocument();
  });

  it('a settings refresh does not overwrite a number being typed', async () => {
    stubFetch({ 'GET /api/dashboard/settings': settings() });
    const { queryClient } = renderCard(<RiskSettingsCard />);
    let tick = 0;
    /** A settings poll landing (Query notifies on the next tick). */
    const refresh = async (value: number) => {
      await act(async () => {
        queryClient.setQueryData(
          qk.dashboard.settings,
          settings({ risk_usd_per_trade: value }),
          { updatedAt: Date.now() + ++tick },
        );
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    const risk = screen.getByLabelText('เสี่ยงต่อไม้ ($)');
    await waitFor(() => {
      expect(risk).toHaveValue(100);
    });

    await userEvent.clear(risk);
    await userEvent.type(risk, '25');
    await refresh(999);
    expect(risk).toHaveValue(25);

    // moving to another input of the grid is still editing
    await userEvent.tab();
    await refresh(997);
    expect(risk).toHaveValue(25);

    // those loads were skipped; the next one after leaving the grid applies
    await userEvent.click(document.body);
    await refresh(998);
    expect(risk).toHaveValue(998);
  });

  it('warns when confidence is above what TA can produce', async () => {
    stubFetch({
      'GET /api/dashboard/settings': settings({
        min_confidence: 10,
        overridden: ['A', 'B'],
      }),
    });
    renderCard(<RiskSettingsCard />, 'viewer');
    expect(await screen.findByText(/^sizing: risk/)).toHaveTextContent(
      'sizing: risk · แก้จากหน้าเว็บ 2 ค่า⚠ confidence 10 สูงกว่าเพดานจริง (8) — บอทจะไม่เปิดไม้เลย',
    );
    expect(
      screen.queryByRole('button', { name: '💾 บันทึกค่าความเสี่ยง' }),
    ).not.toBeInTheDocument();
  });
});
