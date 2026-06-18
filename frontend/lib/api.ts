// DeepEdge backend client (browser-side fetch, CORS enabled)

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "";

export interface MarketSummary {
  oracle_id: string;
  underlying_asset: string;
  status: string;
  expiry: number;
  expiry_iso: string;
  min_strike_usd: number;
  tick_size_usd: number;
  settlement_price_usd: number | null;
  created_checkpoint: number;
}

export interface MarketsResponse {
  count: number;
  markets: MarketSummary[];
}

export interface CalibrationBucket {
  bucket_low: number;
  bucket_high: number;
  bet_count: number;
  avg_implied_prob: number;
  actual_win_rate: number;
  calibration_gap: number;
  avg_roi: number;
  up_count: number;
  up_implied: number;
  up_actual: number;
  down_count: number;
  down_implied: number;
  down_actual: number;
}

export interface CalibrationReport {
  total_settled_oracles: number;
  total_bets_evaluated: number;
  overall_win_rate: number;
  overall_avg_implied: number;
  overall_avg_roi: number;
  mean_abs_calibration_error: number;
  buckets: CalibrationBucket[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function postJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}



// --- Strike grid (single market detail) ---

export interface StrikeRow {
  strike_usd: number;
  log_moneyness: number;
  total_variance: number;
  implied_vol_annualized: number;
  fair_up: number;
  fair_down: number;
}

export interface StrikeGrid {
  spot_usd: number;
  forward_usd: number;
  seconds_until_expiry: number;
  price_age_seconds?: number;
  atm_strike_usd: number;
  strikes: StrikeRow[];
}

export interface StrikesResponse {
  oracle: MarketSummary;
  grid: StrikeGrid;
}

// --- Edge grid (fair vs market) ---

export type EdgeSignal = "no_data" | "buy" | "avoid" | "neutral";

export interface DirectionalEdge {
  fair: number;
  market_ask: number | null;
  ev: number | null;
  signal: EdgeSignal;
  market_ts_ms: number | null;
}

export interface StrikeEdge {
  strike_usd: number;
  log_moneyness: number;
  implied_vol_annualized: number | null;
  up: DirectionalEdge;
  down: DirectionalEdge;
}

export interface BestEdge {
  strike_usd: number;
  direction: string;
  fair: number;
  market_ask: number;
  ev: number;
}

export interface EdgeGrid {
  spot_usd: number;
  forward_usd: number;
  seconds_until_expiry: number;
  atm_strike_usd: number;
  market_data_points: number;
  best_edge: BestEdge | null;
  strikes: StrikeEdge[];
}

export interface EdgesResponse {
  oracle: MarketSummary;
  edge_grid: EdgeGrid | null;
}


// --- PredictManager lookup ---

export interface ManagerEvent {
  manager_id: string;
  owner: string;
  digest: string;
  checkpoint_timestamp_ms: number;
}


export interface PositionMint {
  digest: string;
  oracle_id: string;
  is_up: boolean;
  strike: number;
  quantity: number;
  cost: number;
  ask_price: number;
  checkpoint_timestamp_ms: number;
}

export interface PositionsResponse {
  minted?: PositionMint[];
}

export interface PositionRange {
  digest: string;
  oracle_id: string;
  lower_strike: number;
  higher_strike: number;
  quantity: number;
  cost: number;
  ask_price: number;
  checkpoint_timestamp_ms: number;
}

export interface RangesResponse {
  minted?: PositionRange[];
}

export interface ManagerSummary {
  open_positions: number;
  realized_pnl: number;
  account_value: number;
  balances: { quote_asset: string; balance: number }[];
}

export interface AgentStep {
  stage: string;
  status: string;
  market?: { asset: string; expiry: string; strike_usd: number; oracle_id: string };
  fair?: { up: number; down: number };
  proposal?: { action: string; size: number; thesis: string };
  review?: { approved: boolean; adjusted_size: number; calibration_adjusted_prob: number; verdict: string };
  blob_id?: string;
  sha256?: string;
  match?: boolean;
  spent_amount?: number;
  digest?: string;
  vetoed?: boolean;
  outcome?: string;
  reason?: string;
  error?: string;
}

export interface AgentResult {
  ok: boolean;
  approved?: boolean;
  final_size?: number;
  steps: AgentStep[];
  error?: string;
}

export interface MandateStatus {
  mandate_id: string;
  per_bet_cap: string;
  total_budget: string;
  spent: string;
  active: boolean;
}


export interface LedgerEntry {
  ts: number;
  outcome: string; // "veto" | "no_bet" | "bet" | "unknown"
  market: { asset?: string; strike_usd?: number; expiry?: string; oracle_id?: string } | null;
  fair_up: number | null;
  proposal: { action?: string; size?: number; adjusted_size?: number; thesis?: string } | null;
  verdict: string | null;
  blob_id: string | null;
  sha256: string | null;
  digest: string | null;
}
export interface LedgerSummary {
  total: number;
  veto: number;
  no_bet: number;
  bet: number;
  protected_dusdc: number;
  expected_loss_avoided?: number;
}
export interface LedgerResponse {
  summary: LedgerSummary;
  entries: LedgerEntry[];
}


export interface SurfaceHealthPoint { strike_usd: number; log_moneyness: number; g: number; }
export interface SurfaceHealth { arbitrage_free: boolean; min_g: number; points: SurfaceHealthPoint[]; }
export interface SurfaceHealthResponse { oracle: MarketSummary; health: SurfaceHealth | null; }
export interface CalendarHealth { arbitrage_free: boolean; pairs_checked: number; violations: number; note: string; }

export const api = {
  markets: () => getJson<MarketsResponse>("/api/markets"),
  calibration: () => getJson<CalibrationReport>("/api/backtest/calibration"),
  strikes: (oracleId: string) =>
    getJson<StrikesResponse>(`/api/markets/${oracleId}/strikes?num=15&step=50`),
  edges: (oracleId: string) =>
    getJson<EdgesResponse>(`/api/markets/${oracleId}/edges?num=15&step=50`),
  manager: (owner: string) =>
    getJson<ManagerEvent[]>(`/api/manager?owner=${owner}`),
  positions: (managerId: string) =>
    getJson<PositionsResponse>(`/api/manager/positions?manager=${managerId}`),
  ranges: (managerId: string) =>
    getJson<RangesResponse>(`/api/manager/ranges?manager=${managerId}`),
  summary: (managerId: string) =>
    getJson<ManagerSummary>(`/api/manager/summary?manager=${managerId}`),
  agentRun: () => postJson<AgentResult>("/api/agent/run"),
  agentStatus: () => getJson<MandateStatus>("/api/agent/status"),
  agentLedger: () => getJson<LedgerResponse>("/api/agent/ledger"),
  surfaceHealth: (oracleId: string) => getJson<SurfaceHealthResponse>(`/api/markets/${oracleId}/surface-health`),
  calendarHealth: () => getJson<CalendarHealth>("/api/surface/calendar-health"),
  vaultHealth: (): Promise<VaultHealthResponse> =>
    getJson<VaultHealthResponse>(`/api/vault/health`),
  density: (oracleId: string): Promise<DensityResponse> =>
    getJson<DensityResponse>(`/api/markets/${oracleId}/density`),
  crossVenue: (): Promise<CrossVenueResponse> =>
    getJson<CrossVenueResponse>(`/api/cross-venue`),
};


export interface VaultHealth {
  grade: string;
  vault_value_usd: number;
  max_payout_usd: number;
  total_mtm_usd: number;
  max_payout_utilization: number;
  utilization: number;
  breach_headroom_pct: number;
  available_withdrawal_usd: number;
  withdrawal_headroom_pct: number;
  reasons: string[];
}

export interface VaultSummaryData {
  vault_value: number;
  total_max_payout: number;
  plp_total_supply: number;
  plp_share_price: number;
}

export interface VaultHealthResponse {
  vault: VaultSummaryData;
  health: VaultHealth;
}


export interface DensityPoint {
  strike_usd: number;
  log_moneyness: number;
  density: number;
}

export interface DensityGrid {
  spot_usd: number;
  forward_usd: number;
  seconds_until_expiry: number;
  mode_usd: number;
  prob_up: number;
  p05_usd: number;
  p95_usd: number;
  points: DensityPoint[];
}

export interface DensityResponse {
  oracle: MarketSummary;
  grid: DensityGrid | null;
}


export interface CrossVenueResponse {
  deribit_dvol: number | null;
  binance_realized_vol: number | null;
  realized_window_days: number;
  vol_risk_premium: number | null;
  btc_index_price: number | null;
  predict_atm_iv: number | null;
  predict_tenor_days: number | null;
  predict_vs_deribit: number | null;
  predict_richness: string | null;
}
