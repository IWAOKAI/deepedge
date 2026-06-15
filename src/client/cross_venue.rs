//! Cross-venue volatility reference. On-chain implied vol means little in
//! isolation; what tells an LP whether Predict is rich or cheap, and whether
//! selling vol carries an edge, is the comparison to the rest of the market.
//!
//! We read Deribit's BTC volatility index (DVOL) and Binance's realized vol
//! and frame Predict's ATM IV against them. Both calls are best-effort: if a
//! venue is unreachable the field comes back None and the rest still renders,
//! because a reference that breaks the page is worse than no reference.

use reqwest::Client;
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct CrossVenue {
    /// Deribit BTC volatility index (DVOL), annualized %, if reachable.
    pub deribit_dvol: Option<f64>,
    /// Binance BTC realized volatility over the trailing window, annualized %.
    pub binance_realized_vol: Option<f64>,
    /// Realized-vol window in days (for the realized figure).
    pub realized_window_days: u32,
    /// Volatility risk premium = Deribit implied - Binance realized (%).
    /// Positive means implied richer than realized: selling vol pays.
    pub vol_risk_premium: Option<f64>,
    /// Spot index price from Deribit, for context.
    pub btc_index_price: Option<f64>,
}

#[derive(Clone)]
pub struct CrossVenueClient {
    http: Client,
}

impl CrossVenueClient {
    pub fn new() -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { http }
    }

    /// Deribit DVOL: the latest close of the BTC volatility index.
    async fn deribit_dvol(&self) -> Option<f64> {
        let now = chrono::Utc::now().timestamp_millis();
        let start = now - 7_200_000; // last 2h, hourly resolution
        let url = format!(
            "https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp={}&end_timestamp={}&resolution=3600",
            start, now
        );
        let resp = self.http.get(&url).send().await.ok()?;
        let j: serde_json::Value = resp.json().await.ok()?;
        let data = j.get("result")?.get("data")?.as_array()?;
        let last = data.last()?.as_array()?;
        // [timestamp, open, high, low, close]
        last.get(4)?.as_f64()
    }

    /// Deribit BTC index price (spot reference).
    async fn deribit_index(&self) -> Option<f64> {
        let url = "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd";
        let resp = self.http.get(url).send().await.ok()?;
        let j: serde_json::Value = resp.json().await.ok()?;
        j.get("result")?.get("index_price")?.as_f64()
    }

    /// Binance realized vol from trailing daily closes, annualized %.
    async fn binance_realized_vol(&self, days: u32) -> Option<f64> {
        let url = format!(
            "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit={}",
            days + 1
        );
        let resp = self.http.get(&url).send().await.ok()?;
        let j: serde_json::Value = resp.json().await.ok()?;
        let arr = j.as_array()?;
        let closes: Vec<f64> = arr
            .iter()
            .filter_map(|k| k.as_array()?.get(4)?.as_str()?.parse::<f64>().ok())
            .collect();
        if closes.len() < 3 {
            return None;
        }
        let rets: Vec<f64> = closes
            .windows(2)
            .map(|w| (w[1] / w[0]).ln())
            .collect();
        let n = rets.len() as f64;
        let mean = rets.iter().sum::<f64>() / n;
        let var = rets.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0);
        let daily = var.sqrt();
        Some(daily * (365.0_f64).sqrt() * 100.0)
    }

    /// Assemble the cross-venue read. Each leg degrades to None on failure.
    pub async fn fetch(&self, realized_window_days: u32) -> CrossVenue {
        let dvol = self.deribit_dvol().await;
        let realized = self.binance_realized_vol(realized_window_days).await;
        let index = self.deribit_index().await;

        let vrp = match (dvol, realized) {
            (Some(d), Some(r)) => Some(d - r),
            _ => None,
        };

        CrossVenue {
            deribit_dvol: dvol,
            binance_realized_vol: realized,
            realized_window_days,
            vol_risk_premium: vrp,
            btc_index_price: index,
        }
    }
}
