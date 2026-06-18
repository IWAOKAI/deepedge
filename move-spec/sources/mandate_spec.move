/// Formal specifications for the Mandate enforcement contract.
/// Verified with the Sui Prover (#[spec(prove)]): mathematical proofs
/// over ALL inputs, not example-based tests.
#[spec_only]
module deepedge_mandate::mandate_spec {
    use prover::prover::{ensures, requires};
    use deepedge_mandate::mandate::{Self, Mandate, BetReceipt};

    /// PROOF: the per-bet cap is enforced, and it is a CONCLUSION the Prover
    /// derives -- not an assumption fed in.
    ///
    /// Crucially, amount <= per_bet_cap is NOT a precondition. The only thing
    /// assumed is that the mandate is active. The Prover then proves that if
    /// authorize() returns a receipt at all (i.e. does not abort), that receipt
    /// is within the per-bet cap and equals the requested amount. Since the cap
    /// check is an assert! inside authorize(), the success path is reachable
    /// only when amount <= per_bet_cap -- so cap-compliance is proven, not
    /// presupposed. The agent cannot obtain a receipt above the cap, for all
    /// inputs.
    #[spec(prove, ignore_abort)]
    public fun authorize_respects_cap_spec(m: &Mandate, amount: u64): BetReceipt {
        requires(mandate::is_active(m));
        let r = mandate::authorize(m, amount);
        ensures(mandate::receipt_amount(&r) <= mandate::per_bet_cap(m));
        ensures(mandate::receipt_amount(&r) == amount);
        r
    }
}
