/**
 * Response and request shapes of the backend, taken from docs/api.md (auth, users, audit)
 * and from the handlers behind /api/dashboard/* (src/dashboard/dashboard.controller.ts and
 * the gold services it calls). Instrument keys are typed as `string`: the server builds those
 * maps from its own instrument table, and the UI must not break when one is added.
 */

// ───────────────────────────── auth / users / audit ─────────────────────────────

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  /** 3–32 chars, [a-z0-9._-], lower-cased. The login identifier. */
  username: string;
  name: string;
  role: Role;
  disabled: boolean;
  /** True after create/reset: the UI must force the change-password screen. */
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** `POST /api/auth/login` and `GET /api/auth/me`. */
export interface AuthPayload {
  user: User;
  csrfToken: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  current: boolean;
}

export interface CreateUserRequest {
  username: string;
  name: string;
  role: Role;
  password: string;
}

export interface UpdateUserRequest {
  name?: string;
  role?: Role;
  disabled?: boolean;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: { id: string; username: string } | null;
  /** e.g. auth.login, auth.login_failed, user.create, trade.confirm, settings.update */
  action: string;
  target: string | null;
  ip: string;
  success: boolean;
  detail: Record<string, unknown> | null;
}

export interface AuditPage {
  items: AuditEvent[];
  nextBefore: string | null;
}

// ───────────────────────────── dashboard: instruments ─────────────────────────────

export type GoldMode = 'scalp' | 'intraday' | 'swing' | 'position';
export type InstrumentKind = 'metal' | 'fx';

/** `status.instrument` / `settings.instrument` — the instrument the dashboard is looking at. */
export interface InstrumentInfo {
  key: string;
  name_th: string;
  emoji: string;
  kind: InstrumentKind;
  digits: number;
  pip: number;
  units_per_lot: number;
  quote_ccy: 'USD' | 'JPY';
  symbol_id: number | null;
}

/** One row of `GET /api/dashboard/instruments`. */
export interface InstrumentListItem extends InstrumentInfo {
  daily_range_th: string;
  active: boolean;
}

export interface InstrumentsResponse {
  active: string;
  list: InstrumentListItem[];
}

// ───────────────────────────── dashboard: status ─────────────────────────────

export interface MarketStatus {
  open: boolean;
  /** Thai sentence describing the state. */
  reason: string;
  phase: 'open' | 'daily_break' | 'weekend';
  et_time: string;
  next_open_utc: string | null;
  minutes_to_open: number | null;
  minutes_to_close: number | null;
}

export interface TickPrice {
  bid: number;
  ask: number;
  age_sec: number;
}

export type GoldOrderType =
  'BUY_LIMIT' | 'BUY_STOP' | 'SELL_LIMIT' | 'SELL_STOP' | 'NO_TRADE';
export type GoldSize = 'quarter' | 'half' | 'full';

export interface GoldAiAssist {
  verdict: 'CONFIRM' | 'ADJUST' | 'VETO';
  entry: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  size: GoldSize;
  confidence: number;
  key_levels: string;
  risk_note_th: string;
  reason_th: string;
  news_risk_th?: string;
  invalidation_th?: string;
}

export interface GoldDecision {
  order_type: GoldOrderType;
  entry: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  rr_tp1: number | null;
  confidence: number;
  size: GoldSize;
  valid_until_utc: string | null;
  invalidation: string;
  playbook_ref: string;
  reason: string;
  analysis_summary_th: string;
  ai_assist?: GoldAiAssist;
  near_miss?: boolean;
  near_miss_rule?: string;
}

export interface ModeState {
  lastRunAt: string | null;
  lastBarBucket: number;
  lastDecision: GoldDecision | null;
  lastAssist?: GoldAiAssist | null;
  lastOutcome: string | null;
  lastError: string | null;
}

export interface PendingSummary {
  id: string;
  age_sec: number;
  ttl_sec: number;
  /** Pre-formatted order line, e.g. "BUY_LIMIT @ 4364.09 SL 4357.86 TP1 … (RR 1.8)". */
  order: string;
}

export interface BotStatus {
  enabled: boolean;
  modes: GoldMode[];
  /** Instruments the loop trades at the same time (not the one the page is viewing). */
  enabled_instruments: string[];
  tradable_modes: Record<string, GoldMode[]>;
  blocked_modes: Record<string, GoldMode[]>;
  max_open_positions_total: number;
  accountMode: string;
  engine: string;
  ai_assist: boolean;
  instrument: InstrumentInfo;
  ctraderAuthorized: boolean;
  market: MarketStatus;
  markets: Record<string, MarketStatus>;
  price: TickPrice | null;
  prices: Record<string, TickPrice | null>;
  /** Keyed by mode. */
  pending: Record<string, PendingSummary>;
  /** Keyed by mode. */
  state: Record<string, ModeState>;
}

// ───────────────────────────── dashboard: modes / activity ─────────────────────────────

export interface ModeInfo {
  mode: GoldMode;
  horizon: string;
  tf_roles: string;
  ttl: number;
  rr_min: number;
  files: string[];
}

export interface ModesResponse {
  source: string;
  instrument: string;
  name_th: string;
  emoji: string;
  modes: ModeInfo[];
}

export type ActivityLevel = 'info' | 'ok' | 'warn' | 'error';

export interface ActivityEntry {
  id: number;
  ts: string;
  /** HH:mm:ss Bangkok. */
  bkk: string;
  level: ActivityLevel;
  mode: string | null;
  message: string;
}

export interface ActivityResponse {
  latest_id: number;
  entries: ActivityEntry[];
}

// ───────────────────────────── dashboard: settings / AI ─────────────────────────────

export type AiMode = 'off' | 'assist' | 'lead';
export type AiGate = 'near_miss' | 'always' | 'setup_only';
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface GeminiConfig {
  model: string;
  thinking_level: string;
  thinking: string;
  temperature: number;
  top_k: number;
  top_p: number;
  max_tokens: number;
  timeout_ms: number;
  has_key: boolean;
  api: string;
}

export interface AiCallUsage {
  date_utc: string;
  used: number;
  max: number;
  /** null = unlimited. */
  remaining: number | null;
}

export interface BotSettings {
  risk_usd_per_trade: number;
  daily_max_loss_usd: number;
  max_open_positions: number;
  max_open_positions_total: number;
  /** Cached P&L of the UTC day; null until the bot has read it once. */
  daily_pnl: number | null;
  daily_stop_reset_at: string | null;
  scalp_max_per_day: number;
  min_confidence: number;
  max_lot: number;
  max_lot_by_instrument: Record<string, number>;
  loss_cooldown_bars: number;
  sizing: string;
  ai_assist: boolean;
  ai_mode: AiMode;
  ai_gate: AiGate;
  ai_max_calls_per_day: number;
  ai_calls: AiCallUsage;
  ai: GeminiConfig;
  instrument: InstrumentInfo;
  /** env keys currently overridden from the dashboard. */
  overridden: string[];
}

/** Numeric fields `POST /api/dashboard/settings` accepts. */
export interface RiskSettingsUpdate {
  risk_usd_per_trade?: number;
  daily_max_loss_usd?: number;
  max_open_positions?: number;
  max_open_positions_total?: number;
  scalp_max_per_day?: number;
  min_confidence?: number;
  ai_max_calls_per_day?: number;
  max_lot?: number;
  max_lot_eurusd?: number;
  max_lot_gbpusd?: number;
  max_lot_usdjpy?: number;
}

export interface AiSettingsUpdate {
  ai_mode?: AiMode;
  ai_gate?: AiGate;
  ai_thinking?: ThinkingLevel;
  ai_model?: string;
}

export type SettingsUpdate = RiskSettingsUpdate & AiSettingsUpdate;

export interface AiModel {
  id: string;
  label: string;
  out: number;
}

export interface AiModelsResponse {
  current: string;
  models: AiModel[];
  error?: string;
}

export interface AiResetResult extends AiCallUsage {
  reset_from: number;
}

export interface DailyStopResetResult {
  reset_at: string;
  pnl_before: number | null;
  daily_max_loss_usd: number;
}

// ───────────────────────────── dashboard: actions ─────────────────────────────

export interface AutomateRequest {
  enabled: boolean;
  modes?: GoldMode[];
  instruments?: string[];
}

export interface RunRequest {
  mode: GoldMode;
  force?: boolean;
}

export interface RunResult {
  decision: GoldDecision | null;
  outcome: string;
}

export interface ConfirmResult {
  uuid: string;
  decision: GoldDecision;
}

export interface RejectResult {
  rejected: boolean;
}

// ───────────────────────────── dashboard: records ─────────────────────────────

export interface NewsItem {
  source: string;
  title: string;
  pubDate: string;
  link: string;
  relevant: boolean;
}

export interface ArchiveEntry {
  /** "<mode>/<yyyymmdd_hhmmss>_<mode>.json" */
  file: string;
  mode: string;
  size: number;
  mtime: string;
  outcome: string;
}

/** An archived round. Its payload varies by engine and version, so it stays `unknown`. */
export type ArchiveFile = Record<string, unknown>;

export interface Position {
  positionId: number;
  symbol: string;
  digits: number;
  side: 'BUY' | 'SELL';
  lots: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number | null;
}

export interface TradeRow {
  closed_utc: string;
  position_id: number;
  side: 'BUY' | 'SELL';
  lots: number;
  entry: number;
  close: number;
  gross_usd: number;
  net_usd: number;
  strategy: string;
  h4_trend: 'UP' | 'DOWN' | 'n/a';
  with_trend: boolean | null;
  exit_kind: 'SL' | 'TP' | 'other' | 'n/a';
  hold_min: number | null;
  entry_reason: string | null;
  playbook: string | null;
  archive_file: string | null;
  /** Not sent today (history is per active instrument); the UI falls back to `HistoryResponse.instrument`. */
  instrument?: string;
}

export interface TradeAgg {
  trades: number;
  wins: number;
  losses: number;
  winrate: number;
  net_usd: number;
}

export interface HistoryResponse {
  days: number;
  instrument: string;
  account_mode: string;
  summary: TradeAgg;
  with_h4_trend: TradeAgg;
  against_h4_trend: TradeAgg;
  by_strategy: Record<string, TradeAgg>;
  by_side: Record<'BUY' | 'SELL', TradeAgg>;
  trades: TradeRow[];
}
