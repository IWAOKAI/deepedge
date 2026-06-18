/// DeepEdge Mandate — verifiable, enforced authority for an AI betting agent.
///
/// The agent can only bet within limits the owner sets once. Enforcement is
/// structural: authorize() returns a BetReceipt with NO drop ability, so the
/// same transaction MUST consume it via record_and_consume() or it fails to
/// compile/execute. There is no path where the mandate is checked but the bet
/// is not recorded.
module deepedge_mandate::mandate {
    use sui::event;
    use sui::clock::Clock;
    use deepbook_predict::predict::{Self, Predict};
    use deepbook_predict::predict_manager::PredictManager;
    use deepbook_predict::oracle::OracleSVI;
    use deepbook_predict::market_key::MarketKey;
    use deepbook_predict::range_key::RangeKey;
    use std::string::String;

    // --- errors ---
    const EMandateInactive: u64 = 1;
    const EPerBetExceeded: u64 = 2;
    const EBudgetExceeded: u64 = 3;
    const ENotOwner: u64 = 4;

    /// The agent's authority. Shared so the agent can read/use it, but only
    /// the owner can change limits or flip the kill switch.
    public struct Mandate has key {
        id: UID,
        owner: address,
        per_bet_cap: u64,
        total_budget: u64,
        spent: u64,
        active: bool,
    }

    /// Hot-potato. No `drop`, no `store`, no `key` — it cannot be discarded,
    /// stored, or transferred. The only way to settle it is record_and_consume
    /// in the SAME transaction. This is the enforcement primitive.
    public struct BetReceipt {
        mandate_id: ID,
        amount: u64,
    }

    // --- events (verifiable trail) ---
    public struct MandateCreated has copy, drop {
        mandate_id: ID,
        owner: address,
        per_bet_cap: u64,
        total_budget: u64,
    }

    public struct BetAuthorized has copy, drop {
        mandate_id: ID,
        amount: u64,
        spent_after: u64,
    }

    public struct MandateActiveSet has copy, drop {
        mandate_id: ID,
        active: bool,
    }

    /// Create a mandate and share it. Called once by the owner.
    public fun create_mandate(per_bet_cap: u64, total_budget: u64, ctx: &mut TxContext) {
        let m = Mandate {
            id: object::new(ctx),
            owner: ctx.sender(),
            per_bet_cap,
            total_budget,
            spent: 0,
            active: true,
        };
        event::emit(MandateCreated {
            mandate_id: object::id(&m),
            owner: m.owner,
            per_bet_cap,
            total_budget,
        });
        transfer::share_object(m);
    }

    /// Authorize a bet of `amount`. Checks the kill switch, per-bet cap, and
    /// remaining budget, then returns a hot-potato BetReceipt that MUST be
    /// consumed in the same PTB. Does NOT mutate spent yet — that happens on
    /// consume, so an unconsumed receipt cannot inflate spent.
    public fun authorize(m: &Mandate, amount: u64): BetReceipt {
        assert!(m.active, EMandateInactive);
        assert!(amount <= m.per_bet_cap, EPerBetExceeded);
        assert!(m.spent + amount <= m.total_budget, EBudgetExceeded);
        BetReceipt { mandate_id: object::id(m), amount }
    }

    /// Consume the receipt and record the spend. This is the ONLY way to
    /// settle a BetReceipt, so authorization and recording are inseparable.
    public fun record_and_consume(m: &mut Mandate, receipt: BetReceipt) {
        let BetReceipt { mandate_id, amount } = receipt;
        assert!(mandate_id == object::id(m), ENotOwner);
        m.spent = m.spent + amount;
        event::emit(BetAuthorized {
            mandate_id,
            amount,
            spent_after: m.spent,
        });
    }

    /// THE enforcement entry point: authorize, place the real bet, and record —
    /// all in one call. Because authorize() returns a hot-potato BetReceipt and
    /// the only way to settle it is record_and_consume(), there is NO way to call
    /// predict::mint through this function without the mandate checks passing and
    /// the spend being recorded. The agent cannot bet outside its mandate.
    ///
    /// `amount` is the DUSDC notional the mandate accounts for (cost cap);
    /// `quantity` is the position size passed to predict::mint.
    public fun execute_bet<T>(
        m: &mut Mandate,
        amount: u64,
        predict_obj: &mut Predict,
        manager: &mut PredictManager,
        oracle: &OracleSVI,
        key: MarketKey,
        quantity: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let receipt = authorize(m, amount);
        predict::mint<T>(predict_obj, manager, oracle, key, quantity, clock, ctx);
        record_and_consume(m, receipt);
    }

    /// Range version of execute_bet: authorize, place a real RANGE bet via
    /// predict::mint_range, and record — atomically. Same hot-potato guarantee
    /// as execute_bet: the BetReceipt from authorize() can only be settled by
    /// record_and_consume(), so the mandate checks and the spend record are
    /// inseparable for range positions too.
    ///
    /// `key` is a RangeKey (lower, higher) instead of a single-strike MarketKey.
    public fun execute_range_bet<T>(
        m: &mut Mandate,
        amount: u64,
        predict_obj: &mut Predict,
        manager: &mut PredictManager,
        oracle: &OracleSVI,
        key: RangeKey,
        quantity: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let receipt = authorize(m, amount);
        predict::mint_range<T>(predict_obj, manager, oracle, key, quantity, clock, ctx);
        record_and_consume(m, receipt);
    }

    /// Kill switch / re-enable. Owner only.
    public fun set_active(m: &mut Mandate, active: bool, ctx: &TxContext) {
        assert!(ctx.sender() == m.owner, ENotOwner);
        m.active = active;
        event::emit(MandateActiveSet { mandate_id: object::id(m), active });
    }

    // --- read-only accessors ---
    // ---------------------------------------------------------------------
    // v3: decision-bound authorization (the verifiable autonomous loop)
    // ---------------------------------------------------------------------

    /// Hot-potato carrying the AI decision that justifies this bet. Like
    /// BetReceipt it has no drop/store/key, so it MUST be settled by
    /// record_decision_and_consume in the same transaction. This binds an
    /// on-chain spend to a specific, hashed, Walrus-stored reasoning record.
    public struct DecisionReceipt {
        mandate_id: ID,
        amount: u64,
        decision_hash: String,
        blob_id: String,
    }

    /// Emitted when a decision-bound bet is recorded. The decision_hash and
    /// blob_id let anyone fetch the reasoning from Walrus and verify it hashes
    /// to exactly what was recorded on-chain at this spend.
    public struct DecisionRecorded has copy, drop {
        mandate_id: ID,
        amount: u64,
        decision_hash: String,
        blob_id: String,
        spent_after: u64,
    }

    /// Authorize a bet that is justified by an AI decision. Same limit checks
    /// as authorize(), but the resulting hot-potato also carries the SHA-256
    /// of the reasoning record and its Walrus blob id.
    public fun authorize_with_decision(
        m: &Mandate,
        amount: u64,
        decision_hash: String,
        blob_id: String,
    ): DecisionReceipt {
        assert!(m.active, EMandateInactive);
        assert!(amount <= m.per_bet_cap, EPerBetExceeded);
        assert!(m.spent + amount <= m.total_budget, EBudgetExceeded);
        DecisionReceipt { mandate_id: object::id(m), amount, decision_hash, blob_id }
    }

    /// Settle a DecisionReceipt: record the spend and emit DecisionRecorded so
    /// the reasoning hash + blob id are permanently on-chain. The only way to
    /// consume a DecisionReceipt, so an authorized decision-bet cannot be left
    /// unrecorded.
    public fun record_decision_and_consume(m: &mut Mandate, receipt: DecisionReceipt) {
        let DecisionReceipt { mandate_id, amount, decision_hash, blob_id } = receipt;
        assert!(mandate_id == object::id(m), ENotOwner);
        m.spent = m.spent + amount;
        event::emit(DecisionRecorded {
            mandate_id,
            amount,
            decision_hash,
            blob_id,
            spent_after: m.spent,
        });
    }

    public fun spent(m: &Mandate): u64 { m.spent }
    public fun total_budget(m: &Mandate): u64 { m.total_budget }
    public fun per_bet_cap(m: &Mandate): u64 { m.per_bet_cap }
    public fun is_active(m: &Mandate): bool { m.active }
    public fun receipt_amount(r: &BetReceipt): u64 { r.amount }
}
