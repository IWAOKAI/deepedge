use serde::{Deserialize, Serialize};

/// 価格の精度（DeepBook Predict はオラクル価格に9桁精度を使う）
const PRICE_DECIMALS: f64 = 1e9;
/// DUSDC など quote asset の精度（6桁）
pub const QUOTE_DECIMALS: f64 = 1e6;

/// DeepBook Predict Oracle のメタデータ
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Oracle {
    pub predict_id: String,
    pub oracle_id: String,
    pub oracle_cap_id: String,
    pub underlying_asset: String,
    pub expiry: i64,
    pub min_strike: i64,
    pub tick_size: i64,
    pub status: OracleStatus,
    pub activated_at: i64,
    pub settlement_price: Option<i64>,
    pub settled_at: Option<i64>,
    pub created_checkpoint: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OracleStatus {
    Inactive,
    Active,
    PendingSettlement,
    Settled,
}

/// Oracle の最新価格（spot + forward）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OraclePrice {
    pub oracle_id: String,
    pub checkpoint: i64,
    pub checkpoint_timestamp_ms: i64,
    pub spot: i64,
    pub forward: i64,
    pub onchain_timestamp: i64,
}

/// SVI パラメータ（ボラティリティスマイル）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleSvi {
    pub oracle_id: String,
    pub checkpoint: i64,
    pub checkpoint_timestamp_ms: i64,
    pub a: i64,
    pub b: i64,
    pub rho: i64,
    pub rho_negative: bool,
    pub m: i64,
    pub m_negative: bool,
    pub sigma: i64,
    pub onchain_timestamp: i64,
}

/// Oracle 状態（Oracle + 最新 price + 最新 SVI）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleState {
    pub oracle: Oracle,
    pub latest_price: Option<OraclePrice>,
    pub latest_svi: Option<OracleSvi>,
    pub ask_bounds: Option<serde_json::Value>,
}

impl Oracle {
    /// min_strike を USD に
    pub fn min_strike_usd(&self) -> f64 {
        self.min_strike as f64 / PRICE_DECIMALS
    }

    /// tick_size を USD に
    pub fn tick_size_usd(&self) -> f64 {
        self.tick_size as f64 / PRICE_DECIMALS
    }

    /// settlement_price を USD に
    pub fn settlement_price_usd(&self) -> Option<f64> {
        self.settlement_price.map(|p| p as f64 / PRICE_DECIMALS)
    }

    /// expiry が現在から何秒後か
    pub fn seconds_until_expiry(&self, now_ms: i64) -> i64 {
        (self.expiry - now_ms) / 1000
    }

    /// 期間全体（activated → expiry）の秒数
    pub fn lifetime_seconds(&self) -> i64 {
        (self.expiry - self.activated_at) / 1000
    }

    /// 残り時間の割合（0.0 = expired, 1.0 = just activated）
    pub fn time_remaining_pct(&self, now_ms: i64) -> f64 {
        let total = (self.expiry - self.activated_at) as f64;
        if total <= 0.0 {
            return 0.0;
        }
        let remaining = (self.expiry - now_ms) as f64;
        (remaining / total).clamp(0.0, 1.0)
    }

    pub fn is_active(&self) -> bool {
        // Status must be Active AND the market must not have expired.
        // DeepBook Predict can leave an oracle's status Active past its
        // expiry; such markets have a negative time-to-expiry and a broken
        // IV (0%), so we exclude them from the live list.
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.status == OracleStatus::Active && self.seconds_until_expiry(now_ms) > 0
    }

    pub fn is_settled(&self) -> bool {
        self.status == OracleStatus::Settled
    }
}

impl OraclePrice {
    pub fn spot_usd(&self) -> f64 {
        self.spot as f64 / PRICE_DECIMALS
    }

    pub fn forward_usd(&self) -> f64 {
        self.forward as f64 / PRICE_DECIMALS
    }

    /// フォワード偏差（市場の方向感）
    /// 正 = 市場は上昇予想、負 = 下落予想
    pub fn forward_bias(&self) -> f64 {
        (self.forward as f64 - self.spot as f64) / self.spot as f64
    }
}

impl OracleSvi {
    /// rho を符号付き f64 に
    pub fn rho_signed(&self) -> f64 {
        let val = self.rho as f64 / 1e9;
        if self.rho_negative { -val } else { val }
    }

    /// m を符号付き f64 に
    pub fn m_signed(&self) -> f64 {
        let val = self.m as f64 / 1e9;
        if self.m_negative { -val } else { val }
    }

    /// sigma（ベース ボラ）を f64 に
    pub fn sigma_f(&self) -> f64 {
        self.sigma as f64 / 1e9
    }
}
