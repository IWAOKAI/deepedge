use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::client::PredictServerClient;
use crate::engine::{
    compute_edge_score, compute_strike_grid, compute_edge_grid, compute_surface_health,
    EdgeScore, StrikeGrid, EdgeGrid, MarketAskIndex,
};
use crate::types::{Oracle, OracleState, ManagerSummary};

const PREDICT_ID: &str = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";

#[derive(Clone)]
pub struct AppState {
    pub predict_client: Arc<PredictServerClient>,
}

#[derive(Serialize)]
pub struct MarketListResponse {
    pub count: usize,
    pub active_count: usize,
    pub markets: Vec<MarketSummary>,
}

#[derive(Serialize)]
pub struct MarketSummary {
    pub oracle_id: String,
    pub underlying_asset: String,
    pub expiry: i64,
    pub expiry_iso: String,
    pub status: String,
    pub min_strike_usd: f64,
    pub tick_size_usd: f64,
    pub settlement_price_usd: Option<f64>,
    pub created_checkpoint: i64,
}

impl From<&Oracle> for MarketSummary {
    fn from(o: &Oracle) -> Self {
        let expiry_iso = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(o.expiry)
            .map(|d| d.to_rfc3339())
            .unwrap_or_default();

        Self {
            oracle_id: o.oracle_id.clone(),
            underlying_asset: o.underlying_asset.clone(),
            expiry: o.expiry,
            expiry_iso,
            status: format!("{:?}", o.status).to_lowercase(),
            min_strike_usd: o.min_strike_usd(),
            tick_size_usd: o.tick_size_usd(),
            settlement_price_usd: o.settlement_price_usd(),
            created_checkpoint: o.created_checkpoint,
        }
    }
}

#[derive(Serialize)]
pub struct MarketDetailResponse {
    pub oracle: MarketSummary,
    pub spot_usd: Option<f64>,
    pub forward_usd: Option<f64>,
    pub seconds_until_expiry: i64,
    pub edge_score: Option<EdgeScore>,
}

#[derive(Serialize)]
pub struct StrikesResponse {
    pub oracle: MarketSummary,
    pub grid: Option<StrikeGrid>,
}

#[derive(Deserialize)]
pub struct StrikesQuery {
    /// 表示するストライク数（デフォルト 11、奇数推奨）
    pub num: Option<usize>,
    /// ストライク間隔（tick の倍数。デフォルト 50 = $50 刻み）
    pub step: Option<i64>,
}

pub async fn list_markets(
    State(state): State<AppState>,
) -> Result<Json<MarketListResponse>, (StatusCode, String)> {
    let oracles = state
        .predict_client
        .list_active_oracles(PREDICT_ID)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let active_count = oracles.iter().filter(|o| o.is_active()).count();
    let count = oracles.len();

    let mut markets: Vec<MarketSummary> = oracles.iter().map(MarketSummary::from).collect();
    markets.sort_by(|a, b| {
        let a_active = a.status == "active";
        let b_active = b.status == "active";
        b_active
            .cmp(&a_active)
            .then(b.created_checkpoint.cmp(&a.created_checkpoint))
    });

    Ok(Json(MarketListResponse {
        count,
        active_count,
        markets,
    }))
}

pub async fn get_market(
    State(state): State<AppState>,
    Path(oracle_id): Path<String>,
) -> Result<Json<MarketDetailResponse>, (StatusCode, String)> {
    let oracle_state: OracleState = state
        .predict_client
        .oracle_state(&oracle_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let now_ms = chrono::Utc::now().timestamp_millis();

    let edge_score = match (
        oracle_state.oracle.is_active(),
        &oracle_state.latest_price,
        &oracle_state.latest_svi,
    ) {
        (true, Some(price), Some(svi)) => {
            Some(compute_edge_score(&oracle_state.oracle, price, svi, now_ms))
        }
        _ => None,
    };

    Ok(Json(MarketDetailResponse {
        oracle: MarketSummary::from(&oracle_state.oracle),
        spot_usd: oracle_state.latest_price.as_ref().map(|p| p.spot_usd()),
        forward_usd: oracle_state.latest_price.as_ref().map(|p| p.forward_usd()),
        seconds_until_expiry: oracle_state.oracle.seconds_until_expiry(now_ms),
        edge_score,
    }))
}

pub async fn get_strikes(
    State(state): State<AppState>,
    Path(oracle_id): Path<String>,
    Query(q): Query<StrikesQuery>,
) -> Result<Json<StrikesResponse>, (StatusCode, String)> {
    let oracle_state: OracleState = state
        .predict_client
        .oracle_state(&oracle_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let num_strikes = q.num.unwrap_or(11);
    let step_ticks = q.step.unwrap_or(50);
    let now_ms = chrono::Utc::now().timestamp_millis();

    let grid = match (&oracle_state.latest_price, &oracle_state.latest_svi) {
        (Some(price), Some(svi)) => Some(compute_strike_grid(
            &oracle_state.oracle,
            price,
            svi,
            now_ms,
            num_strikes,
            step_ticks,
        )),
        _ => None,
    };

    Ok(Json(StrikesResponse {
        oracle: MarketSummary::from(&oracle_state.oracle),
        grid,
    }))
}

#[derive(serde::Serialize)]
pub struct DensityResponse {
    pub oracle: MarketSummary,
    pub grid: Option<crate::engine::strike_grid::DensityGrid>,
}

/// GET /api/markets/:id/density
/// The risk-neutral density the SVI surface prices (Breeden-Litzenberger),
/// with the mode, P(up) and 5th/95th percentile band read off the curve.
pub async fn get_density(
    State(state): State<AppState>,
    Path(oracle_id): Path<String>,
) -> Result<Json<DensityResponse>, (StatusCode, String)> {
    let oracle_state: OracleState = state
        .predict_client
        .oracle_state(&oracle_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let now_ms = chrono::Utc::now().timestamp_millis();

    let grid = match (&oracle_state.latest_price, &oracle_state.latest_svi) {
        (Some(price), Some(svi)) => {
            let params = crate::engine::svi::SviParams::from_event(svi);
            let mut g = crate::engine::strike_grid::compute_density(price, &params, 81, 0.5);
            g.seconds_until_expiry = oracle_state.oracle.seconds_until_expiry(now_ms);
            Some(g)
        }
        _ => None,
    };

    Ok(Json(DensityResponse {
        oracle: MarketSummary::from(&oracle_state.oracle),
        grid,
    }))
}


#[derive(Serialize)]
pub struct SurfaceHealthResponse {
    pub oracle: MarketSummary,
    pub health: Option<crate::engine::strike_grid::SurfaceHealth>,
}

/// GET /api/markets/:oracle_id/surface-health
/// Butterfly-arbitrage check on the oracle's SVI surface: evaluates
/// Gatheral's g(k) across strikes; arbitrage_free iff min g(k) >= 0.
pub async fn get_surface_health(
    State(state): State<AppState>,
    Path(oracle_id): Path<String>,
    Query(q): Query<StrikesQuery>,
) -> Result<Json<SurfaceHealthResponse>, (StatusCode, String)> {
    let oracle_state = state
        .predict_client
        .oracle_state(&oracle_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let num_strikes = q.num.unwrap_or(15);
    let step_ticks = q.step.unwrap_or(50);

    let health = match (&oracle_state.latest_price, &oracle_state.latest_svi) {
        (Some(price), Some(svi)) => Some(compute_surface_health(
            &oracle_state.oracle, price, svi, num_strikes, step_ticks,
        )),
        _ => None,
    };

    Ok(Json(SurfaceHealthResponse {
        oracle: MarketSummary::from(&oracle_state.oracle),
        health,
    }))
}


#[derive(Serialize)]
pub struct EdgesResponse {
    pub oracle: MarketSummary,
    pub edge_grid: Option<EdgeGrid>,
}

pub async fn get_edges(
    State(state): State<AppState>,
    Path(oracle_id): Path<String>,
    Query(q): Query<StrikesQuery>,
) -> Result<Json<EdgesResponse>, (StatusCode, String)> {
    let oracle_state = state
        .predict_client
        .oracle_state(&oracle_id)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    // 最新 100 件の mint を取得し、この oracle の market ask index を構築
    let mints = state
        .predict_client
        .positions_minted(100)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    let ask_index = MarketAskIndex::from_mints(&mints, &oracle_id);

    let num_strikes = q.num.unwrap_or(11);
    let step_ticks = q.step.unwrap_or(50);
    let now_ms = chrono::Utc::now().timestamp_millis();

    let edge_grid = match (&oracle_state.latest_price, &oracle_state.latest_svi) {
        (Some(price), Some(svi)) => Some(compute_edge_grid(
            &oracle_state.oracle,
            price,
            svi,
            &ask_index,
            now_ms,
            num_strikes,
            step_ticks,
        )),
        _ => None,
    };

    Ok(Json(EdgesResponse {
        oracle: MarketSummary::from(&oracle_state.oracle),
        edge_grid,
    }))
}


#[derive(Serialize)]
pub struct CalendarHealthResponse {
    pub arbitrage_free: bool,
    pub pairs_checked: usize,
    pub violations: usize,
    pub note: String,
}

/// GET /api/surface/calendar-health
/// Calendar-arbitrage check across all active oracles: total variance must
/// be non-decreasing in maturity at a fixed log-moneyness. We sample a
/// shared k-grid and confirm w_T2(k) >= w_T1(k) for every T2 > T1.
pub async fn get_calendar_health(
    State(state): State<AppState>,
) -> Result<Json<CalendarHealthResponse>, (StatusCode, String)> {
    let oracles = state
        .predict_client
        .list_active_oracles(PREDICT_ID)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    let now_ms = chrono::Utc::now().timestamp_millis();

    // Collect (seconds_to_expiry, SviParams) for active oracles with SVI.
    let mut curves: Vec<(i64, crate::engine::svi::SviParams)> = Vec::new();
    for o in &oracles {
        if let Ok(st) = state.predict_client.oracle_state(&o.oracle_id).await {
            if let Some(svi) = &st.latest_svi {
                let secs = st.oracle.seconds_until_expiry(now_ms);
                if secs > 0 {
                    curves.push((secs, crate::engine::svi::SviParams::from_event(svi)));
                }
            }
        }
    }
    curves.sort_by_key(|(s, _)| *s);

    // Shared log-moneyness grid.
    let ks: Vec<f64> = (-10..=10).map(|i| i as f64 * 0.01).collect();
    let mut pairs = 0usize;
    let mut violations = 0usize;
    for a in 0..curves.len() {
        for b in (a + 1)..curves.len() {
            pairs += 1;
            let (_, ref pa) = curves[a];
            let (_, ref pb) = curves[b];
            // pb is the longer maturity; require w_b(k) >= w_a(k) - eps
            for &k in &ks {
                if pb.total_variance(k) + 1e-9 < pa.total_variance(k) {
                    violations += 1;
                    break;
                }
            }
        }
    }

    Ok(Json(CalendarHealthResponse {
        arbitrage_free: violations == 0,
        pairs_checked: pairs,
        violations,
        note: format!("{} active SVI curves compared on a shared log-moneyness grid", curves.len()),
    }))
}


/// GET /api/walrus/:blob_id
/// Server-side proxy for Walrus blobs. The public testnet aggregator
/// returns 404 when a browser sends an Origin header, so we fetch the blob
/// here (no Origin) and stream the raw bytes back. This lets the Ledger's
/// in-browser Verify-hash button re-hash the exact stored bytes over a
/// same-origin request.
pub async fn get_walrus_blob(
    Path(blob_id): Path<String>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let url = format!("https://aggregator.walrus-testnet.walrus.space/v1/blobs/{}", blob_id);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    if !resp.status().is_success() {
        return Err((StatusCode::NOT_FOUND, format!("walrus aggregator returned {}", resp.status())));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    use axum::response::IntoResponse;
    let mut response = bytes.to_vec().into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/octet-stream"),
    );
    Ok(response)
}


#[derive(Deserialize)]
pub struct ManagerQuery {
    pub owner: String,
}

pub async fn get_manager(
    State(state): State<AppState>,
    Query(q): Query<ManagerQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let result = state
        .predict_client
        .managers_by_owner(&q.owner)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(result))
}


#[derive(Deserialize)]
pub struct ManagerIdQuery {
    pub manager: String,
}

pub async fn get_positions(
    State(state): State<AppState>,
    Query(q): Query<ManagerIdQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let result = state
        .predict_client
        .manager_positions(&q.manager)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(result))
}

pub async fn get_summary(
    State(state): State<AppState>,
    Query(q): Query<ManagerIdQuery>,
) -> Result<Json<ManagerSummary>, (StatusCode, String)> {
    let result = state
        .predict_client
        .manager_summary(&q.manager)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(result))
}

#[derive(serde::Serialize)]
pub struct VaultHealthResponse {
    pub vault: crate::types::vault::VaultSummary,
    pub health: crate::engine::vault_health::VaultHealth,
}

/// GET /api/vault/health
/// The PLP vault's solvency read: a GREEN/AMBER/RED grade plus the numbers
/// that justify it (worst-case payout coverage, utilization, exit liquidity).
pub async fn get_vault_health(
    State(state): State<AppState>,
) -> Result<Json<VaultHealthResponse>, (StatusCode, String)> {
    let vault = state
        .predict_client
        .vault_summary(PREDICT_ID)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    let health = crate::engine::vault_health::compute_vault_health(&vault);
    Ok(Json(VaultHealthResponse { vault, health }))
}

