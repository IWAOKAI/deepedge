//! Vault solvency read for the PLP vault that underwrites every Predict
//! position. The vault is the counterparty to every trade, so its health
//! is the market's health. This turns the raw vault summary into a single
//! GREEN / AMBER / RED grade plus the few numbers that justify it -- the
//! same "one clear read" a desk would keep open, and an input the agent's
//! Risk Officer can reason about before sizing any bet.

use serde::Serialize;
use crate::types::vault::VaultSummary;

#[derive(Debug, Clone, Serialize)]
pub struct VaultHealth {
    /// Overall grade: "GREEN" (safe), "AMBER" (caution), "RED" (breach risk).
    pub grade: String,
    pub vault_value_usd: f64,
    /// Total maximum payout the vault is on the hook for, in USD.
    pub max_payout_usd: f64,
    /// Mark-to-market of the open book, in USD.
    pub total_mtm_usd: f64,
    /// Fraction of vault value committed to worst-case payout (0..1+).
    pub max_payout_utilization: f64,
    /// General utilization (0..1).
    pub utilization: f64,
    /// How much of the vault is left after worst-case payout, as a percent
    /// of vault value. Negative means the worst case exceeds the vault.
    pub breach_headroom_pct: f64,
    /// Free liquidity available to honor withdrawals right now, in USD.
    pub available_withdrawal_usd: f64,
    /// Fraction of vault value that LPs can actually withdraw right now.
    pub withdrawal_headroom_pct: f64,
    /// Human-readable reasons behind the grade.
    pub reasons: Vec<String>,
}

/// Grade the vault from its summary. Pure function of the on-chain numbers.
///
/// The thresholds encode an LP's real questions:
///   - Can the vault cover its worst-case payout? (breach headroom)
///   - How much of its capital is already committed? (max-payout util)
///   - Can LPs actually exit right now? (withdrawal headroom)
pub fn compute_vault_health(v: &VaultSummary) -> VaultHealth {
    let vault_value = v.vault_value as f64 / 1e6;
    let max_payout = v.total_max_payout as f64 / 1e6;
    let total_mtm = v.total_mtm as f64 / 1e6;
    let available_withdrawal = v.available_withdrawal as f64 / 1e6;

    // Breach headroom: vault value left after the worst-case payout,
    // as a percent of vault value. <= 0 means insolvent in the worst case.
    let breach_headroom_pct = if vault_value > 0.0 {
        (vault_value - max_payout) / vault_value * 100.0
    } else {
        -100.0
    };

    let withdrawal_headroom_pct = if vault_value > 0.0 {
        available_withdrawal / vault_value * 100.0
    } else {
        0.0
    };

    let mpu = v.max_payout_utilization;
    let mut reasons: Vec<String> = Vec::new();

    // Grade by the worst signal among payout coverage, utilization, exit.
    let mut grade = "GREEN";

    if breach_headroom_pct < 0.0 {
        grade = "RED";
        reasons.push(format!(
            "Worst-case payout (${:.0}) exceeds vault value (${:.0}): negative breach headroom.",
            max_payout, vault_value
        ));
    } else if mpu > 0.90 {
        grade = "RED";
        reasons.push(format!(
            "Max-payout utilization {:.0}% leaves almost no buffer.",
            mpu * 100.0
        ));
    } else if mpu > 0.70 {
        grade = "AMBER";
        reasons.push(format!(
            "Max-payout utilization {:.0}% is elevated.",
            mpu * 100.0
        ));
    }

    if withdrawal_headroom_pct < 5.0 && grade != "RED" {
        // Thin exit liquidity is at least a caution.
        if grade == "GREEN" {
            grade = "AMBER";
        }
        reasons.push(format!(
            "Only {:.1}% of vault value is withdrawable right now.",
            withdrawal_headroom_pct
        ));
    }

    if reasons.is_empty() {
        reasons.push(format!(
            "Worst-case payout covered with {:.0}% headroom; utilization {:.0}%.",
            breach_headroom_pct, mpu * 100.0
        ));
    }

    VaultHealth {
        grade: grade.to_string(),
        vault_value_usd: vault_value,
        max_payout_usd: max_payout,
        total_mtm_usd: total_mtm,
        max_payout_utilization: mpu,
        utilization: v.utilization,
        breach_headroom_pct,
        available_withdrawal_usd: available_withdrawal,
        withdrawal_headroom_pct,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> VaultSummary {
        VaultSummary {
            predict_id: "0x0".into(),
            quote_assets: vec![],
            vault_balance: 1_000_000_000,
            vault_value: 1_000_000_000, // $1000
            total_mtm: 0,
            total_max_payout: 500_000_000, // $500
            available_liquidity: 800_000_000,
            available_withdrawal: 800_000_000, // $800
            plp_total_supply: 1_000_000_000,
            plp_share_price: 1.0,
            utilization: 0.3,
            max_payout_utilization: 0.5,
            net_deposits: 1_000_000_000,
            total_supplied: 1_000_000_000,
            total_withdrawn: 0,
        }
    }

    #[test]
    fn healthy_vault_is_green() {
        let h = compute_vault_health(&base());
        assert_eq!(h.grade, "GREEN", "reasons: {:?}", h.reasons);
        assert!(h.breach_headroom_pct > 0.0);
    }

    #[test]
    fn elevated_utilization_is_amber() {
        let mut v = base();
        v.max_payout_utilization = 0.75;
        v.total_max_payout = 750_000_000;
        let h = compute_vault_health(&v);
        assert_eq!(h.grade, "AMBER", "reasons: {:?}", h.reasons);
    }

    #[test]
    fn worst_case_exceeding_vault_is_red() {
        let mut v = base();
        v.total_max_payout = 1_200_000_000; // $1200 > $1000 vault
        v.max_payout_utilization = 1.2;
        let h = compute_vault_health(&v);
        assert_eq!(h.grade, "RED", "reasons: {:?}", h.reasons);
        assert!(h.breach_headroom_pct < 0.0);
    }
}
