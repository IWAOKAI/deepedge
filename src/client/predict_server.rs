use anyhow::{Context, Result};
use reqwest::Client;
use std::time::Duration;
use std::path::PathBuf;

use crate::types::{Oracle, OracleState, ManagerSummary, ManagerPnl, VaultSummary, PositionMint};

const DEFAULT_BASE_URL: &str = "https://predict-server.testnet.mystenlabs.com";

/// DeepBook Predict Public Server のクライアント
#[derive(Clone)]
pub struct PredictServerClient {
    base_url: String,
    http: Client,
}

impl PredictServerClient {
    pub fn new() -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .context("failed to build HTTP client")?;

        let base_url = std::env::var("PREDICT_SERVER_URL")
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        Ok(Self {
            base_url,
            http,
        })
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .context("failed to build HTTP client")?;

        Ok(Self {
            base_url: base_url.into(),
            http,
        })
    }

    /// GET /status
    pub async fn status(&self) -> Result<serde_json::Value> {
        let url = format!("{}/status", self.base_url);
        let res = self.http.get(&url).send().await?.error_for_status()?;
        Ok(res.json().await?)
    }

    /// GET /predicts/:predict_id/oracles
    pub async fn list_oracles(&self, predict_id: &str) -> Result<Vec<Oracle>> {
        let url = format!("{}/predicts/{}/oracles", self.base_url, predict_id);
        let key = format!("list_oracles_{}", predict_id);
        match self.http.get(&url).send().await.and_then(|r| r.error_for_status()) {
            Ok(res) => match res.json::<Vec<Oracle>>().await {
                Ok(v) => {
                    write_cache(&key, &v);
                    Ok(v)
                }
                Err(e) => read_cache::<Vec<Oracle>>(&key)
                    .ok_or(())
                    .map_err(|_| anyhow::anyhow!("decode failed and no cache: {}", e)),
            },
            Err(e) => read_cache::<Vec<Oracle>>(&key)
                .ok_or(())
                .map_err(|_| anyhow::anyhow!("fetch failed and no cache: {}", e)),
        }
    }

    /// 同上、status == "active" のみフィルター
    pub async fn list_active_oracles(&self, predict_id: &str) -> Result<Vec<Oracle>> {
        let all = self.list_oracles(predict_id).await?;
        Ok(all.into_iter().filter(|o| o.is_active()).collect())
    }

    /// GET /oracles/:oracle_id/state
    pub async fn oracle_state(&self, oracle_id: &str) -> Result<OracleState> {
        let url = format!("{}/oracles/{}/state", self.base_url, oracle_id);
        let key = format!("oracle_state_{}", oracle_id);
        match self.http.get(&url).send().await.and_then(|r| r.error_for_status()) {
            Ok(res) => match res.json::<OracleState>().await {
                Ok(v) => {
                    write_cache(&key, &v);
                    Ok(v)
                }
                Err(e) => read_cache::<OracleState>(&key)
                    .ok_or(())
                    .map_err(|_| anyhow::anyhow!("decode failed and no cache: {}", e)),
            },
            Err(e) => read_cache::<OracleState>(&key)
                .ok_or(())
                .map_err(|_| anyhow::anyhow!("fetch failed and no cache: {}", e)),
        }
    }

    /// GET /predicts/:predict_id/vault/summary
    pub async fn vault_summary(&self, predict_id: &str) -> Result<VaultSummary> {
        let url = format!("{}/predicts/{}/vault/summary", self.base_url, predict_id);
        let key = format!("vault_summary_{}", predict_id);
        match self.http.get(&url).send().await.and_then(|r| r.error_for_status()) {
            Ok(res) => match res.json::<VaultSummary>().await {
                Ok(v) => {
                    write_cache(&key, &v);
                    Ok(v)
                }
                Err(e) => read_cache::<VaultSummary>(&key)
                    .ok_or(())
                    .map_err(|_| anyhow::anyhow!("decode failed and no cache: {}", e)),
            },
            Err(e) => read_cache::<VaultSummary>(&key)
                .ok_or(())
                .map_err(|_| anyhow::anyhow!("fetch failed and no cache: {}", e)),
        }
    }

    /// GET /managers/:manager_id/summary
    pub async fn manager_summary(&self, manager_id: &str) -> Result<ManagerSummary> {
        let url = format!("{}/managers/{}/summary", self.base_url, manager_id);
        let res = self.http.get(&url).send().await?.error_for_status()?;
        Ok(res.json().await?)
    }

    /// GET /managers/:manager_id/pnl?range=ALL
    pub async fn manager_pnl(&self, manager_id: &str, range: &str) -> Result<ManagerPnl> {
        let url = format!("{}/managers/{}/pnl?range={}", self.base_url, manager_id, range);
        let res = self.http.get(&url).send().await?.error_for_status()?;
        Ok(res.json().await?)
    }

    /// GET /positions/minted?limit=N
    /// 最新 N 件の binary position mint を取得（全 oracle 横断、サーバー側 oracle フィルタは無い）
    /// GET /managers?owner=ADDR
    /// 指定 owner の PredictManager イベントを返す（無ければ空配列）
    /// GET /managers/{id}/positions
    /// 指定 manager のベット履歴（minted positions 等）を返す
    pub async fn manager_positions(&self, manager_id: &str) -> Result<serde_json::Value> {
        let url = format!("{}/managers/{}/positions", self.base_url, manager_id);
        let res = self.http.get(&url).send().await?.error_for_status()?;
        Ok(res.json().await?)
    }

    pub async fn managers_by_owner(&self, owner: &str) -> Result<serde_json::Value> {
        let url = format!("{}/managers?owner={}", self.base_url, owner);
        let res = self.http.get(&url).send().await?.error_for_status()?;
        Ok(res.json().await?)
    }

    pub async fn positions_minted(&self, limit: usize) -> Result<Vec<PositionMint>> {
        let url = format!("{}/positions/minted?limit={}", self.base_url, limit);
        let res = self.http.get(&url).send().await?.error_for_status()?;
        Ok(res.json().await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREDICT_ID: &str = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";

    #[tokio::test]
    #[ignore = "hits live Predict Server; run with --ignored"]
    async fn test_status() {
        let client = PredictServerClient::new().unwrap();
        let status = client.status().await.unwrap();
        assert_eq!(status["status"], "OK");
    }

    #[tokio::test]
    #[ignore = "hits live Predict Server; run with --ignored"]
    async fn test_list_oracles() {
        let client = PredictServerClient::new().unwrap();
        let oracles = client.list_oracles(PREDICT_ID).await.unwrap();
        assert!(!oracles.is_empty());
    }
}


/// On-disk cache directory for last-good responses. Lets a demo survive a
/// transient outage of the external Predict server: when a live fetch
/// fails, we fall back to the most recent successful response instead of
/// breaking the page. The data is still real -- just a few moments old.
fn cache_path(key: &str) -> PathBuf {
    let dir = PathBuf::from("/root/deepedge/cache");
    let _ = std::fs::create_dir_all(&dir);
    // Sanitize the key into a safe filename.
    let safe: String = key
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    dir.join(format!("{}.json", safe))
}

fn write_cache<T: serde::Serialize>(key: &str, value: &T) {
    if let Ok(bytes) = serde_json::to_vec(value) {
        let _ = std::fs::write(cache_path(key), bytes);
    }
}

fn read_cache<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    let bytes = std::fs::read(cache_path(key)).ok()?;
    serde_json::from_slice(&bytes).ok()
}
