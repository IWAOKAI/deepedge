use axum::{
    routing::{get, post},
    http::StatusCode,
    Json, Router,
};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;

use deepedge::api::{AppState, list_markets, get_market, get_strikes, get_density, get_surface_health, get_calendar_health, get_walrus_blob, get_edges, get_manager, get_positions, get_summary, get_vault_health, get_cross_venue, run_agent, agent_status, agent_ledger};
use deepedge::api::backtest::{calibration, accuracy};
use deepedge::client::PredictServerClient;
use tower_http::cors::CorsLayer;

#[derive(Serialize)]
struct StatusResponse {
    name: String,
    version: String,
    status: String,
    description: String,
}

async fn root() -> &'static str {
    "DeepEdge API - Don't Bet Blind. See the Math."
}

async fn health() -> Json<StatusResponse> {
    Json(StatusResponse {
        name: "DeepEdge".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        status: "OK".to_string(),
        description: "Data-driven prediction market platform on DeepBook Predict".to_string(),
    })
}

async fn fallback() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "Not Found")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let predict_client = Arc::new(PredictServerClient::new()?);
    let cross_venue_client = std::sync::Arc::new(deepedge::client::cross_venue::CrossVenueClient::new());
    let state = AppState { predict_client, cross_venue_client };

    let app = Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/api/markets", get(list_markets))
        .route("/api/markets/:oracle_id", get(get_market))
        .route("/api/markets/:oracle_id/strikes", get(get_strikes))
        .route("/api/markets/:oracle_id/density", get(get_density))
        .route("/api/markets/:oracle_id/surface-health", get(get_surface_health))
        .route("/api/surface/calendar-health", get(get_calendar_health))
        .route("/api/walrus/:blob_id", get(get_walrus_blob))
        .route("/api/markets/:oracle_id/edges", get(get_edges))
        .route("/api/backtest/calibration", get(calibration))
        .route("/api/backtest/accuracy", get(accuracy))
        .route("/api/manager", get(get_manager))
        .route("/api/manager/positions", get(get_positions))
        .route("/api/manager/summary", get(get_summary))
        .route("/api/vault/health", get(get_vault_health))
        .route("/api/cross-venue", get(get_cross_venue))
        .route("/api/agent/run", post(run_agent))
        .route("/api/agent/status", get(agent_status))
        .route("/api/agent/ledger", get(agent_ledger))
        .fallback(fallback)
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    tracing::info!("DeepEdge API starting on http://{}", addr);
    axum::serve(listener, app).await?;

    Ok(())
}
