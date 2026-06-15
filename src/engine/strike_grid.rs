//! Strike grid: あるオラクルに対して、forward 周辺の複数ストライクで
//! 公正確率（UP / DOWN）を計算する。
//!
//! 表示用の MVP として:
//!   - forward の周りに num_strikes 個のストライクを選ぶ
//!   - DeepBook Predict の tick_size に揃える
//!   - 各ストライクで P(UP), P(DOWN) を計算
//!
//! 時間調整:
//!   SVI が返す total_variance は「満期までの分散」だが、現在から満期までの
//!   残り時間で再スケールしたいケースもある。今は素直に w(k) をそのまま使う
//!   （DeepBook Predict のオラクルが返す SVI が「残り T」基準である前提）。

use serde::Serialize;

use crate::engine::pricing::{binary_call_probability, binary_put_probability};
use crate::engine::svi::SviParams;
use crate::engine::market_edge::{MarketAskIndex, DirectionalEdge, EdgeSignal, evaluate_direction};
use crate::types::{Oracle, OraclePrice, OracleSvi};

#[derive(Debug, Clone, Serialize)]
pub struct StrikeFairProbability {
    pub strike_usd: f64,
    pub log_moneyness: f64,
    pub total_variance: f64,
    pub implied_vol_annualized: Option<f64>,
    pub fair_up: f64,
    pub fair_down: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StrikeGrid {
    pub spot_usd: f64,
    pub forward_usd: f64,
    pub seconds_until_expiry: i64,
    pub price_age_seconds: i64,
    pub atm_strike_usd: f64,
    pub strikes: Vec<StrikeFairProbability>,
}

/// 標準的な ATM の選び方: forward を tick_size に丸める
fn round_to_tick(value_usd: f64, tick_usd: f64) -> f64 {
    if tick_usd <= 0.0 {
        return value_usd;
    }
    (value_usd / tick_usd).round() * tick_usd
}

/// num_strikes 個のストライクを atm の上下に等間隔で生成
fn strike_grid_usd(atm_usd: f64, tick_usd: f64, step_ticks: i64, num_strikes: usize) -> Vec<f64> {
    if num_strikes == 0 {
        return vec![];
    }
    let half = (num_strikes / 2) as i64;
    let step_usd = tick_usd * step_ticks as f64;
    (-half..=half)
        .take(num_strikes)
        .map(|i| (atm_usd + step_usd * i as f64).max(0.0))
        .collect()
}

const SECONDS_PER_YEAR: f64 = 365.25 * 24.0 * 3600.0;

/// Oracle 状態から StrikeGrid を計算
pub fn compute_strike_grid(
    oracle: &Oracle,
    price: &OraclePrice,
    svi: &OracleSvi,
    now_ms: i64,
    num_strikes: usize,
    step_ticks: i64,
) -> StrikeGrid {
    let svi_params = SviParams::from_event(svi);
    let forward = price.forward_usd();
    let spot = price.spot_usd();
    let tick = oracle.tick_size_usd();

    let atm = round_to_tick(forward, tick);
    let strikes_usd = strike_grid_usd(atm, tick, step_ticks, num_strikes);

    let seconds_to_expiry = oracle.seconds_until_expiry(now_ms).max(0);
    let time_to_expiry_years = (seconds_to_expiry as f64) / SECONDS_PER_YEAR;

    let strikes: Vec<StrikeFairProbability> = strikes_usd
        .iter()
        .map(|&k_usd| {
            // SVI は log-moneyness ln(K/F) で評価
            let log_moneyness = if forward > 0.0 && k_usd > 0.0 {
                (k_usd / forward).ln()
            } else {
                0.0
            };
            let w = svi_params.total_variance(log_moneyness);
            let iv = if time_to_expiry_years > 0.0 && w > 0.0 {
                Some((w / time_to_expiry_years).sqrt())
            } else {
                None
            };
            let fair_up = binary_call_probability(forward, k_usd, w);
            let fair_down = binary_put_probability(forward, k_usd, w);
            StrikeFairProbability {
                strike_usd: k_usd,
                log_moneyness,
                total_variance: w,
                implied_vol_annualized: iv,
                fair_up,
                fair_down,
            }
        })
        .collect();

    StrikeGrid {
        spot_usd: spot,
        forward_usd: forward,
        seconds_until_expiry: oracle.seconds_until_expiry(now_ms),
        price_age_seconds: (now_ms - price.onchain_timestamp) / 1000,
        atm_strike_usd: atm,
        strikes,
    }
}


/// market ask を結合した、1ストライクの完全な edge 情報
#[derive(Debug, Clone, Serialize)]
pub struct StrikeEdge {
    pub strike_usd: f64,
    pub log_moneyness: f64,
    pub implied_vol_annualized: Option<f64>,
    pub up: DirectionalEdge,
    pub down: DirectionalEdge,
}

/// best edge（全ストライク×方向のうち最大 EV）
#[derive(Debug, Clone, Serialize)]
pub struct BestEdge {
    pub strike_usd: f64,
    pub direction: String,
    pub fair: f64,
    pub market_ask: f64,
    pub ev: f64,
}

/// market ask を結合した edge grid 全体
#[derive(Debug, Clone, Serialize)]
pub struct EdgeGrid {
    pub spot_usd: f64,
    pub forward_usd: f64,
    pub seconds_until_expiry: i64,
    pub price_age_seconds: i64,
    pub atm_strike_usd: f64,
    pub market_data_points: usize,
    pub best_edge: Option<BestEdge>,
    pub strikes: Vec<StrikeEdge>,
}

/// strike grid を計算し、market ask を結合して EV まで出す
pub fn compute_edge_grid(
    oracle: &Oracle,
    price: &OraclePrice,
    svi: &OracleSvi,
    ask_index: &MarketAskIndex,
    now_ms: i64,
    num_strikes: usize,
    step_ticks: i64,
) -> EdgeGrid {
    let base = compute_strike_grid(oracle, price, svi, now_ms, num_strikes, step_ticks);

    let mut best: Option<BestEdge> = None;

    let strikes: Vec<StrikeEdge> = base
        .strikes
        .iter()
        .map(|s| {
            let up = evaluate_direction(s.fair_up, ask_index.lookup_with_ts(s.strike_usd, true));
            let down =
                evaluate_direction(s.fair_down, ask_index.lookup_with_ts(s.strike_usd, false));

            // best edge 更新（Buy シグナルかつ EV 最大）
            for (de, dir) in [(&up, "up"), (&down, "down")] {
                if de.signal == EdgeSignal::Buy {
                    if let (Some(ev), Some(market)) = (de.ev, de.market_ask) {
                        let better = match &best {
                            None => true,
                            Some(b) => ev > b.ev,
                        };
                        if better {
                            best = Some(BestEdge {
                                strike_usd: s.strike_usd,
                                direction: dir.to_string(),
                                fair: de.fair,
                                market_ask: market,
                                ev,
                            });
                        }
                    }
                }
            }

            StrikeEdge {
                strike_usd: s.strike_usd,
                log_moneyness: s.log_moneyness,
                implied_vol_annualized: s.implied_vol_annualized,
                up,
                down,
            }
        })
        .collect();

    EdgeGrid {
        spot_usd: base.spot_usd,
        forward_usd: base.forward_usd,
        seconds_until_expiry: base.seconds_until_expiry,
        price_age_seconds: (now_ms - price.onchain_timestamp) / 1000,
        atm_strike_usd: base.atm_strike_usd,
        market_data_points: ask_index.len(),
        best_edge: best,
        strikes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_size_matches_request() {
        let oracle = Oracle {
            predict_id: "".into(),
            oracle_id: "".into(),
            oracle_cap_id: "".into(),
            underlying_asset: "BTC".into(),
            expiry: 2_000_000_000_000,
            min_strike: 50_000_000_000_000,
            tick_size: 1_000_000_000,
            status: crate::types::OracleStatus::Active,
            activated_at: 1_900_000_000_000,
            settlement_price: None,
            settled_at: None,
            created_checkpoint: 0,
        };
        let price = OraclePrice {
            oracle_id: "".into(),
            checkpoint: 0,
            checkpoint_timestamp_ms: 0,
            spot: 66_000_000_000_000,
            forward: 66_000_000_000_000,
            onchain_timestamp: 0,
        };
        let svi = OracleSvi {
            oracle_id: "".into(),
            checkpoint: 0,
            checkpoint_timestamp_ms: 0,
            a: 36_000,
            b: 600_000,
            rho: 940_000_000,
            rho_negative: true,
            m: 19_900_000,
            m_negative: false,
            sigma: 10_000_000,
            onchain_timestamp: 0,
        };
        let now_ms = 1_950_000_000_000;
        let grid = compute_strike_grid(&oracle, &price, &svi, now_ms, 11, 10);
        assert_eq!(grid.strikes.len(), 11);
        // 中央が ATM 付近
        let mid = &grid.strikes[5];
        assert!((mid.strike_usd - grid.atm_strike_usd).abs() < 1e-6);
    }
}

/// Butterfly-arbitrage health of a single oracle's SVI surface.
/// Evaluates Gatheral's g(k) across the strike grid; the surface is
/// butterfly-arbitrage-free iff g(k) >= 0 everywhere.
#[derive(serde::Serialize)]
pub struct SurfaceHealth {
    pub arbitrage_free: bool,
    pub min_g: f64,
    pub points: Vec<SurfaceHealthPoint>,
}

#[derive(serde::Serialize)]
pub struct SurfaceHealthPoint {
    pub strike_usd: f64,
    pub log_moneyness: f64,
    pub g: f64,
}

pub fn compute_surface_health(
    oracle: &crate::types::Oracle,
    price: &crate::types::OraclePrice,
    svi: &crate::types::OracleSvi,
    num_strikes: usize,
    step_ticks: i64,
) -> SurfaceHealth {
    let params = SviParams::from_event(svi);
    let forward = price.forward_usd();
    let tick = oracle.tick_size_usd();
    let atm = (forward / tick).round() * tick;

    let half = (num_strikes / 2) as i64;
    let mut points = Vec::new();
    let mut min_g = f64::INFINITY;

    for i in -half..=half {
        let strike = atm + (i as f64) * (step_ticks as f64) * tick;
        if strike <= 0.0 {
            continue;
        }
        let k = (strike / forward).ln();
        let g = params.butterfly_g(k);
        if g < min_g {
            min_g = g;
        }
        points.push(SurfaceHealthPoint { strike_usd: strike, log_moneyness: k, g });
    }

    SurfaceHealth {
        arbitrage_free: min_g >= 0.0,
        min_g,
        points,
    }
}


/// A single point on the risk-neutral density curve.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DensityPoint {
    pub strike_usd: f64,
    pub log_moneyness: f64,
    pub density: f64,
}

/// The risk-neutral density the SVI surface prices, sampled across strikes,
/// plus the summary an analyst actually reads off it: the mode (most likely
/// settlement price), P(up) = P(S_T > F), and the 5th/95th percentile band.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DensityGrid {
    pub spot_usd: f64,
    pub forward_usd: f64,
    pub seconds_until_expiry: i64,
    pub mode_usd: f64,
    pub prob_up: f64,
    pub p05_usd: f64,
    pub p95_usd: f64,
    pub points: Vec<DensityPoint>,
}

/// Build the density grid from the live oracle price and SVI smile.
/// Samples k = ln(K/F) on a symmetric grid, evaluates the Breeden-
/// Litzenberger density, normalizes it numerically (trapezoid), and reads
/// off the mode, P(up) and tail quantiles from the normalized curve.
pub fn compute_density(
    price: &OraclePrice,
    svi: &SviParams,
    num_points: usize,
    k_max: f64,
) -> DensityGrid {
    let forward = price.forward_usd();
    let spot = price.spot_usd();
    let n = num_points.max(11);
    let dk = (2.0 * k_max) / (n as f64 - 1.0);

    // First pass: raw density on the grid.
    let mut ks: Vec<f64> = Vec::with_capacity(n);
    let mut raw: Vec<f64> = Vec::with_capacity(n);
    for i in 0..n {
        let k = -k_max + i as f64 * dk;
        ks.push(k);
        raw.push(svi.risk_neutral_density(k));
    }

    // Normalizing constant via trapezoid over k.
    let mut area = 0.0;
    for i in 1..n {
        area += 0.5 * (raw[i - 1] + raw[i]) * dk;
    }
    if area <= 0.0 {
        area = 1.0;
    }

    // Build normalized points and locate the mode.
    let mut points = Vec::with_capacity(n);
    let mut mode_k = 0.0;
    let mut mode_d = -1.0;
    for i in 0..n {
        let k = ks[i];
        let dens = raw[i] / area;
        let strike = forward * k.exp();
        if dens > mode_d {
            mode_d = dens;
            mode_k = k;
        }
        points.push(DensityPoint { strike_usd: strike, log_moneyness: k, density: dens });
    }

    // P(up) = P(S_T > F) = integral of normalized density over k > 0.
    // Tail quantiles from the cumulative distribution.
    let mut cdf = 0.0;
    let mut prob_up = 0.0;
    let mut p05 = forward * (-k_max).exp();
    let mut p95 = forward * k_max.exp();
    let mut got05 = false;
    let mut got95 = false;
    for i in 1..n {
        let seg = 0.5 * (raw[i - 1] + raw[i]) * dk / area;
        cdf += seg;
        if !got05 && cdf >= 0.05 {
            p05 = forward * ks[i].exp();
            got05 = true;
        }
        if !got95 && cdf >= 0.95 {
            p95 = forward * ks[i].exp();
            got95 = true;
        }
        if ks[i] > 0.0 {
            prob_up += seg;
        }
    }

    DensityGrid {
        spot_usd: spot,
        forward_usd: forward,
        seconds_until_expiry: 0,
        mode_usd: forward * mode_k.exp(),
        prob_up,
        p05_usd: p05,
        p95_usd: p95,
        points,
    }
}
