use axum::{extract::State, http::StatusCode, Json};
use serde_json::Value;
use std::process::Command;

use crate::api::markets::AppState;

const RPC: &str = "https://fullnode.testnet.sui.io:443";
const PACKAGE: &str = "0xb82750b35a213320d5ad6204e7bce46493ae76340e2a018fd65fdca4ad08f34a";
const MANDATE: &str = "0x215e9f0c5b894dccdaf189d4a3e041f181f5a854cc814ad8cfd4c1061ddf0dd9";


/// POST /api/agent/run
/// Runs ONE full two-agent autonomous cycle (Strategist proposes, Risk
/// Officer reviews/vetoes), stores the decision on Walrus, hashes it,
/// enforces the Mandate on-chain, and verifies the blob -- returning the
/// structured per-stage result as JSON.
pub async fn run_agent(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // --- Public-demo rate limit: 20 AI cycles per day (UTC) ---
    {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut guard = state.agent_runs.lock().unwrap();
        if guard.0 != today {
            *guard = (today.clone(), 0);
        }
        if guard.1 >= 20 {
            return Err((StatusCode::TOO_MANY_REQUESTS,
                "Daily limit reached: this public demo allows 20 AI cycles per day. \
                 The agent has already run 20 times today — please try again tomorrow. \
                 (The full agent has no such limit; this only protects the demo.)".to_string()));
        }
        guard.1 += 1;
    }

    // The cycle calls the Claude API + Walrus + an on-chain PTB, so it can
    // take ~20-40s. We run the existing, proven Python loop in --json mode.
    let output = tokio::task::spawn_blocking(|| {
        Command::new("python3")
            .arg("scripts/deepedge_loop_api.py")
            .arg("--json")
            .current_dir("/root/deepedge")
            .output()
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("join error: {e}")))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("spawn error: {e}")))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err((StatusCode::BAD_GATEWAY, format!("loop failed: {err}")));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // The script prints a single JSON object on stdout.
    let parsed: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR,
            format!("bad JSON from loop: {e}; raw: {stdout}")))?;
    Ok(Json(parsed))
}

/// GET /api/agent/status
/// Returns the current Mandate state (per-bet cap, budget, spent, active)
/// by querying the on-chain object via the Sui fullnode RPC.
pub async fn agent_status(
    State(_state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {

    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "sui_getObject",
        "params": [MANDATE, {"showContent": true}]
    });

    let client = reqwest::Client::new();
    let resp = client.post(RPC).json(&body).send().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    let json: Value = resp.json().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

    // Extract the fields we care about; fall back to the raw object.
    let fields = &json["result"]["data"]["content"]["fields"];
    let out = serde_json::json!({
        "mandate_id": MANDATE,
        "per_bet_cap": fields["per_bet_cap"],
        "total_budget": fields["total_budget"],
        "spent": fields["spent"],
        "active": fields["active"],
    });
    Ok(Json(out))
}

/// GET /api/agent/ledger -- the agent's full decision history.
/// Reads decisions/ledger.jsonl (every cycle: bet, veto, or no_bet, each
/// with its Walrus blob id + sha256) and returns a summary + entries,
/// newest first. This is the audit trail: every decision the agent ever
/// made can be independently re-verified against Walrus and the chain.
pub async fn agent_ledger(
    State(_state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let path = "/root/deepedge/decisions/ledger.jsonl";
    let content = std::fs::read_to_string(path).unwrap_or_default();

    let mut entries: Vec<Value> = Vec::new();
    let mut veto = 0u64;
    let mut no_bet = 0u64;
    let mut bet = 0u64;
    let mut protected: u64 = 0;
    let mut expected_loss: f64 = 0.0; // micro-DUSDC, calibration-weighted

    for line in content.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        let ts = row["ts"].clone();
        let r = &row["result"];
        let steps = r["steps"].as_array().cloned().unwrap_or_default();

        let mut outcome = "unknown".to_string();
        let mut market = Value::Null;
        let mut fair_up = Value::Null;
        let mut proposal = Value::Null;
        let mut verdict = Value::Null;
        let mut verdict_prob: Option<f64> = None;
        let mut blob_id = Value::Null;
        let mut sha256 = Value::Null;
        let mut digest = Value::Null;

        for s in &steps {
            match s["stage"].as_str().unwrap_or("") {
                "observe" => {
                    market = s["market"].clone();
                    fair_up = s["fair"]["up"].clone();
                }
                "strategist" => { proposal = s["proposal"].clone(); }
                "risk_officer" => { verdict = s["review"]["verdict"].clone(); verdict_prob = s["review"]["calibration_adjusted_prob"].as_f64(); }
                "walrus" => {
                    blob_id = s["blob_id"].clone();
                    sha256 = s["sha256"].clone();
                }
                "enforce" => {
                    if let Some(o) = s["outcome"].as_str() { outcome = o.to_string(); }
                    digest = s["digest"].clone();
                }
                _ => {}
            }
        }

        let proposed_size = proposal["adjusted_size"].as_u64()
            .or(proposal["size"].as_u64()).unwrap_or(0);
        match outcome.as_str() {
            "veto" => {
                veto += 1;
                protected += proposed_size;
                // Expected loss if this vetoed bet had been placed: use the
                // gap between the Strategist's implied prob and the
                // calibration-adjusted prob as the fraction of stake at risk.
                let fair = fair_up.as_f64().unwrap_or(0.5);
                let cal = verdict_prob.unwrap_or(fair);
                let gap = (fair - cal).abs().max(0.39); // floor at the bucket's ~-39% ROI
                expected_loss += proposed_size as f64 * gap;
            }
            "no_bet" => { no_bet += 1; }
            "bet" => { bet += 1; }
            _ => {}
        }

        entries.push(serde_json::json!({
            "ts": ts,
            "outcome": outcome,
            "market": market,
            "fair_up": fair_up,
            "proposal": proposal,
            "verdict": verdict,
            "blob_id": blob_id,
            "sha256": sha256,
            "digest": digest,
        }));
    }

    // Enrich with on-chain DecisionRecorded events: match by blob_id so
    // each bet that actually hit the chain carries its tx digest, which the
    // UI links to suivision. This ties the local audit trail to the chain.
    let rpc_body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1,
        "method": "suix_queryEvents",
        "params": [
            {"MoveEventType": format!("{}::mandate::DecisionRecorded", PACKAGE)},
            null, 50, true
        ]
    });
    let client = reqwest::Client::new();
    if let Ok(resp) = client.post(RPC).json(&rpc_body).send().await {
        if let Ok(j) = resp.json::<Value>().await {
            if let Some(evs) = j["result"]["data"].as_array() {
                // build blob_id -> tx digest map
                let mut chain: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                for e in evs {
                    let blob = e["parsedJson"]["blob_id"].as_str().unwrap_or("").to_string();
                    let dg = e["id"]["txDigest"].as_str().unwrap_or("").to_string();
                    if !blob.is_empty() && !dg.is_empty() {
                        chain.insert(blob, dg);
                    }
                }
                for ent in entries.iter_mut() {
                    if let Some(blob) = ent["blob_id"].as_str() {
                        if let Some(dg) = chain.get(blob) {
                            ent["onchain_digest"] = Value::String(dg.clone());
                        }
                    }
                }
            }
        }
    }

    entries.reverse(); // newest first

    let out = serde_json::json!({
        "summary": {
            "total": entries.len(),
            "veto": veto,
            "no_bet": no_bet,
            "bet": bet,
            "protected_dusdc": protected,
            "expected_loss_avoided": expected_loss.round() as u64,
        },
        "entries": entries,
    });
    Ok(Json(out))
}

