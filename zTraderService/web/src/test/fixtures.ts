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
  name_th: 'Gold',
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
  name_th: 'Euro / US dollar',
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
  name_th: 'US dollar / Yen',
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
  name_th: 'Gold',
  emoji: '🥇',
  modes: [
    {
      mode: 'scalp',
      horizon: '1–4 h',
      tf_roles: '5m',
      ttl: 60,
      rr_min: 1.5,
      files: [],
    },
    {
      mode: 'swing',
      horizon: 'several days',
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
      reason: 'Gold market open (10:00 ET)',
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
      thinking: 'level low',
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

export const riskProfiles = {
  balance: 10_000,
  active: null,
  profiles: [
    {
      id: 'builtin:balanced',
      name: 'Balanced',
      description: '1% risk per trade',
      builtIn: true,
      values: {
        risk_per_trade: { unit: 'pct' as const, value: 1 },
        daily_max_loss: { unit: 'pct' as const, value: 4 },
        max_open_positions: 4,
        max_open_positions_total: 6,
        min_confidence: 7,
        loss_cooldown_bars: 3,
        scalp_max_per_day: 8,
      },
      resolved: {
        risk_usd_per_trade: 100,
        daily_max_loss_usd: 400,
        max_open_positions: 4,
        max_open_positions_total: 6,
        min_confidence: 7,
        loss_cooldown_bars: 3,
        scalp_max_per_day: 8,
      },
      createdBy: null,
      updatedAt: null,
    },
    {
      id: 'builtin:micro',
      name: 'Micro account',
      description: '$10 risk',
      builtIn: true,
      values: {
        risk_per_trade: { unit: 'usd' as const, value: 10 },
        daily_max_loss: { unit: 'usd' as const, value: 30 },
        max_open_positions: 1,
        max_open_positions_total: 1,
        min_confidence: 7,
        loss_cooldown_bars: 3,
        scalp_max_per_day: 5,
        max_lot: { XAUUSD: 0.01 },
      },
      resolved: {
        risk_usd_per_trade: 10,
        daily_max_loss_usd: 30,
        max_open_positions: 1,
        max_open_positions_total: 1,
        min_confidence: 7,
        loss_cooldown_bars: 3,
        scalp_max_per_day: 5,
        max_lot_xauusd: 0.01,
      },
      createdBy: null,
      updatedAt: null,
    },
  ],
};

/** every read endpoint the shell polls, answered with fixtures */
export function baseRoutes(): Record<string, unknown> {
  return {
    'GET /api/dashboard/status': status(),
    'GET /api/dashboard/settings': settings(),
    'GET /api/dashboard/instruments': instruments,
    'GET /api/dashboard/modes': modes,
    'GET /api/dashboard/positions': [],
    'GET /api/dashboard/account': {
      available: true,
      accountId: 1234567,
      mode: 'DEMO',
      balance: 10_000,
      currency: 'USD',
      leverage: 500,
      updatedAt: null,
    },
    'GET /api/dashboard/ai/models': {
      current: 'gemini-3.5-flash',
      provider: 'gemini',
      has_gemini_key: true,
      has_claude_key: false,
      models: [
        {
          id: 'gemini-3.5-flash',
          label: 'Gemini 3.5 Flash',
          provider: 'gemini',
          modes: ['assist', 'lead', 'ai_only'],
        },
      ],
    },
    'GET /api/dashboard/activity': { latest_id: 0, entries: [] },
    'GET /api/dashboard/news': [],
    'GET /api/dashboard/archive': [],
    'GET /api/dashboard/history': {
      days: 30,
      instrument: 'XAUUSD',
      account_mode: 'DEMO',
      summary: { trades: 0, wins: 0, losses: 0, winrate: 0, net_usd: 0 },
      with_h4_trend: { trades: 0, wins: 0, losses: 0, winrate: 0, net_usd: 0 },
      against_h4_trend: {
        trades: 0,
        wins: 0,
        losses: 0,
        winrate: 0,
        net_usd: 0,
      },
      by_strategy: {},
      by_side: {
        BUY: { trades: 0, wins: 0, losses: 0, winrate: 0, net_usd: 0 },
        SELL: { trades: 0, wins: 0, losses: 0, winrate: 0, net_usd: 0 },
      },
      trades: [],
    },
    'GET /api/risk-profiles': riskProfiles,
    'GET /api/chart/sources': {
      symbol: 'XAUUSD',
      sources: [
        { id: 'ctrader', label: 'cTrader (account broker)', kind: 'broker' },
        { id: 'tv:OANDA', label: 'OANDA', kind: 'tradingview' },
      ],
    },
    'GET /api/chart/bars': {
      symbol: 'XAUUSD',
      source: 'ctrader',
      tf: 'M15',
      bars: [
        {
          time: 1_790_000_000,
          open: 4000,
          high: 4010,
          low: 3995,
          close: 4005,
          volume: 100,
        },
        {
          time: 1_790_000_900,
          open: 4005,
          high: 4012,
          low: 4001,
          close: 4008,
          volume: 90,
        },
      ],
    },
    'GET /api/actor/state': {
      available: true,
      isRunning: false,
      symbols: ['XAUUSD'],
      mode: 'Sonic',
      maxPositions: 2,
      modes: ['Sonic', 'Scalper'],
      symbolsLive: [
        {
          symbol: 'XAUUSD',
          price: 4005,
          rsi: 55.2,
          ema: 4001,
          lastUpdate: null,
          hasReceived: false,
        },
      ],
    },
    'GET /api/actor/logs': {
      latestId: 1,
      entries: [
        {
          id: 1,
          ts: '2026-10-30T10:00:00.000Z',
          type: 'info',
          message: '[Exec] 🔌 Connected to Market Data Gateway',
          channel: 'system',
        },
      ],
    },
  };
}
