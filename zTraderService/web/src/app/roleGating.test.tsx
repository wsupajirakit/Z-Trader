import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '../api/types';
import { dialogs } from '../lib/dialogs';
import { stubFetch } from '../test/fetchStub';
import {
  instruments,
  modes,
  session,
  settings,
  status,
} from '../test/fixtures';
import { App } from './App';
import { createQueryClient } from './queryClient';
import { createAppRouter } from './router';
import { installSessionHandlers } from './sessionHandlers';

const pending = {
  swing: {
    id: 'p-1',
    age_sec: 30,
    ttl_sec: 570,
    order: 'BUY_LIMIT @ 4360 SL 4350 TP1 4380 (RR 2)',
  },
};

function renderDashboard(role: Role) {
  const calls = stubFetch({
    'GET /api/auth/me': session(role),
    'GET /api/dashboard/status': status({ pending }),
    'GET /api/dashboard/instruments': instruments,
    'GET /api/dashboard/modes': modes,
    'GET /api/dashboard/settings': settings(),
    'GET /api/dashboard/positions': [],
    'GET /api/dashboard/archive': [],
    'GET /api/dashboard/activity': { latest_id: 0, entries: [] },
    'GET /api/dashboard/ai/models': { current: 'gemini-3.5-flash', models: [] },
    'POST /api/dashboard/automate': status({ enabled: true, modes: ['swing'] }),
  });
  const queryClient = createQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  installSessionHandlers(router, queryClient);
  render(<App queryClient={queryClient} router={router} />);
  return calls;
}

const operatorButtons = [
  '▶ รันเลย',
  '🔍 วิเคราะห์ก่อน',
  'Start Auto Loop',
  '💾 บันทึกค่าความเสี่ยง',
  '🔄 รีเซ็ต',
  'เคลียร์ daily stop',
  '✓ ยิง',
  '✕ ปัดตก',
];

describe('role gating on the dashboard', () => {
  it('a viewer sees state but no trading action and no admin menu', async () => {
    renderDashboard('viewer');
    await screen.findByText(
      '⏳ รอตรวจ (เหลือ 570s): BUY_LIMIT @ 4360 SL 4350 TP1 4380 (RR 2)',
    );

    for (const name of operatorButtons) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('combobox', { name: 'ตราสาร' })).toBeDisabled();
    expect(
      screen.getByRole('spinbutton', { name: 'เสี่ยงต่อไม้ ($)' }),
    ).toHaveAttribute('readonly');
    for (const b of within(
      screen.getByRole('group', { name: 'บทบาทของ AI' }),
    ).getAllByRole('button')) {
      expect(b).toBeDisabled();
    }
    const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' });
    expect(
      within(nav).queryByRole('link', { name: 'ผู้ใช้' }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).queryByRole('link', { name: 'Audit log' }),
    ).not.toBeInTheDocument();
  });

  it('an operator gets every trading action but still no admin menu', async () => {
    renderDashboard('operator');
    await screen.findByRole('button', { name: '✓ ยิง' });

    for (const name of operatorButtons) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('combobox', { name: 'ตราสาร' })).toBeEnabled();
    expect(
      screen.queryByRole('link', { name: 'ผู้ใช้' }),
    ).not.toBeInTheDocument();
  });

  it('an admin also gets the admin menu', async () => {
    renderDashboard('admin');
    const nav = await screen.findByRole('navigation', { name: 'เมนูหลัก' });
    expect(
      await within(nav).findByRole('link', { name: 'ผู้ใช้' }),
    ).toHaveAttribute('href', '/admin/users');
    expect(
      within(nav).getByRole('link', { name: 'Audit log' }),
    ).toBeInTheDocument();
  });

  it('Start Auto Loop posts the checked instruments × modes with the CSRF token', async () => {
    vi.spyOn(dialogs, 'alert').mockImplementation(() => undefined);
    const calls = renderDashboard('operator');
    const start = await screen.findByRole('button', {
      name: 'Start Auto Loop',
    });
    await screen.findByRole('checkbox', { name: 'scalp' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'scalp' }));
    await userEvent.click(start);

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/dashboard/automate');
    expect(post?.body).toEqual({
      enabled: true,
      modes: ['scalp', 'swing'],
      instruments: ['XAUUSD'],
    });
    expect(post?.headers.get('X-CSRF-Token')).toBe('csrf-test-token');
    expect(
      await screen.findByText('auto loop เปิด: XAUUSD × scalp, swing'),
    ).toBeInTheDocument();
    expect(dialogs.alert).not.toHaveBeenCalled();
  });
});
