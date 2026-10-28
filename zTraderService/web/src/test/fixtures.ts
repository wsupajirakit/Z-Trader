import type {
  AuthPayload,
  BotSettings,
  BotStatus,
  InstrumentListItem,
  InstrumentsResponse,
  ModesResponse,
  Role,
  User,
} from '../api/types';

export function user(role: Role, over: Partial<User> = {}): User {
  return {
    id: `u-${role}`,
    username: role,
    name: `Test ${role}`,
    role,
    disabled: false,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export function session(role: Role, over: Partial<User> = {}): AuthPayload {
  return { user: user(role, over), csrfToken: 'csrf-test-token' };
}

export const XAU: InstrumentListItem = {
  key: 'XAUUSD',
  name_th: 'ทองคำ',
  emoji: '🥇',
  kind: 'metal',
  digits: 2,
  pip: 0.1,
  units_per_lot: 100,
  quote_ccy: 'USD',
  symbol_id: 41,
  daily_range_th: '$30–60',
  active: true,
};

export const EUR: InstrumentListItem = {
  key: 'EURUSD',
  name_th: 'ยูโร/ดอลลาร์',
  emoji: '🇪🇺',
  kind: 'fx',
  digits: 5,
  pip: 0.0001,
  units_per_lot: 100_000,
  quote_ccy: 'USD',
  symbol_id: 1,
  daily_range_th: '60–90 pip',
  active: false,
};

export const JPY: InstrumentListItem = {
  ...EUR,
  key: 'USDJPY',
  name_th: 'ดอลลาร์/เยน',
  emoji: '🇯🇵',
  digits: 3,
  pip: 0.01,
  quote_ccy: 'JPY',
  symbol_id: 4,
};

export const instruments: InstrumentsResponse = {
  active: 'XAUUSD',
  list: [XAU, EUR, JPY],
};

export const modes: ModesResponse = {
  source: 'local',
  instrument: 'XAUUSD',
  name_th: 'ทองคำ',
  emoji: '🥇',
  modes: [
    {
      mode: 'scalp',
      horizon: '1–4 ชม.',
      tf_roles: '5m',
      ttl: 60,
      rr_min: 1.5,
      files: [],
    },
    {
      mode: 'swing',
      horizon: 'หลายวัน',
      tf_roles: '1d',
      ttl: 300,
      rr_min: 2,
      files: [],
    },
  ],
};

export function status(over: Partial<BotStatus> = {}): BotStatus {
  const {
    units_per_lot,
    quote_ccy,
    symbol_id,
    key,
    name_th,
    emoji,
    kind,
    digits,
    pip,
  } = XAU;
  return {
    enabled: false,
    modes: ['swing'],
    enabled_instruments: ['XAUUSD'],
    tradable_modes: { XAUUSD: ['scalp', 'swing'] },
    blocked_modes: { XAUUSD: [] },
    max_open_positions_total: 0,
    accountMode: 'DEMO',
    engine: 'ta',
    ai_assist: false,
    instrument: {
      key,
      name_th,
      emoji,
      kind,
      digits,
      pip,
      units_per_lot,
      quote_ccy,
      symbol_id,
    },
    ctraderAuthorized: true,
    market: {
      open: true,
      reason: 'ตลาดทองเปิด (10:00 ET)',
      phase: 'open',
      et_time: '10:00',
      next_open_utc: null,
      minutes_to_open: null,
      minutes_to_close: 425,
    },
    markets: {},
    price: { bid: 4364.091, ask: 4364.4, age_sec: 1 },
    prices: {},
    pending: {},
    state: {},
    ...over,
  };
}

export function settings(over: Partial<BotSettings> = {}): BotSettings {
  return {
    risk_usd_per_trade: 100,
    daily_max_loss_usd: 400,
    max_open_positions: 4,
    max_open_positions_total: 0,
    daily_pnl: null,
    daily_stop_reset_at: null,
    scalp_max_per_day: 8,
    min_confidence: 7,
    max_lot: 0.5,
    max_lot_by_instrument: { XAUUSD: 0.5, EURUSD: 2, GBPUSD: 2, USDJPY: 2 },
    loss_cooldown_bars: 3,
    sizing: 'risk',
    ai_assist: false,
    ai_mode: 'off',
    ai_gate: 'near_miss',
    ai_max_calls_per_day: 10,
    ai_calls: { date_utc: '2026-10-28', used: 3, max: 10, remaining: 7 },
    ai: {
      model: 'gemini-3.5-flash',
      thinking_level: 'low',
      thinking: 'ระดับ low',
      temperature: 0.2,
      top_k: 40,
      top_p: 0.95,
      max_tokens: 16384,
      timeout_ms: 180000,
      has_key: true,
      api: 'generateContent',
    },
    instrument: status().instrument,
    overridden: [],
    ...over,
  };
}
