# DeepEdge

**Don't Bet Blind. See the Math.**

A trader-facing analytics and betting layer for DeepBook Predict on Sui — see the fair-value math behind every market, then place a bet in one tap.

> Submission for Sui Overflow 2026 — DeepBook Track

![Market detail: SVI volatility smile, fair-probability table, and the bet panel](docs/screenshots/market.png)

---

## The problem

Prediction markets today let you bet, but not *think*. As the official DeepBook Predict brief puts it, most venues "have no real notion of an underlying volatility surface." Traders see an odds number and click — with no way to ask *is this price fair?*

DeepBook Predict fixes the protocol side: it prices every strike and expiry against a live SVI volatility surface. But the trader still needs a lens to read that surface and judge each bet. **That lens is DeepEdge.**

---

## Why this is different from a trading bot

The hard part of prediction markets is not placing trades -- plenty of
bots do that. The hard part is **trusting an automated system with real
money**. A keeper that prices a surface and fires orders is only as
trustworthy as its operator's promise that it won't misbehave. DeepEdge
takes the opposite stance: every layer is constrained and checkable.

| | A typical auto-trading bot | DeepEdge |
|---|---|---|
| Places real on-chain trades | yes | yes |
| Prices against an on-chain SVI/IV surface | yes | yes |
| **Desk-grade analytics (density, vault grade, cross-venue)** | rarely | **yes -- Breeden-Litzenberger density, PLP solvency grade, Deribit/Binance vol** |
| **A second agent that can veto the first** | no | **yes -- Risk Officer, using calibration** |
| **On-chain spending limit it cannot bypass** | no | **yes -- hot-potato Mandate** |
| **Formally verified the limit holds for all inputs** | no | **yes -- Sui Prover** |
| **Every decision stored + hash-anchored, re-verifiable** | no | **yes -- Walrus + on-chain** |
| **A public ledger of every call it ever made** | no | **yes -- the Ledger screen** |
| Discloses its own negative-ROI / miscalibration | rarely | **yes, openly** |
| **Non-custodial -- never holds user funds** | varies (some are custodial) | **yes -- the agent's funds are capped by an on-chain Mandate** |

A bot says *trust me*. DeepEdge says *check me* -- and gives you the
buttons to do it: re-hash any decision against Walrus in your browser,
follow any real bet to suivision, and read the formal-verification proof
that the spending cap can never be exceeded. That is the difference
between automating trades and building an AI agent you can actually be
accountable for.

## What DeepEdge does

DeepEdge sits on top of DeepBook Predict and turns its on-chain volatility surface into something a trader can actually use:

- **Fair value for every strike.** We read each oracle's on-chain SVI parameters and compute the model probability that BTC settles above (UP) or below (DOWN) each strike, using an SVI total-variance model with log-normal binary pricing.
- **The volatility smile, visualized.** Every market's implied-volatility curve across strikes, rendered live, so you can see the skew the market is pricing in.
- **Market calibration, measured.** A backtest over 831 settled bets shows exactly where the market is reliable and where it is systematically mispriced (details below).
- **One-tap betting.** Connect a wallet, see the fair value, confirm, and place a real on-chain bet — deposit DUSDC into your PredictManager and mint a position, all from the market page.
- **Your positions, tracked.** Every bet you place, with fill price, cost, and realized P&L, read straight from on-chain data.
- **Desk-grade reads on the surface.** The risk-neutral density the surface implies (Breeden-Litzenberger), the PLP vault's GREEN/AMBER/RED solvency grade, and a cross-venue vol comparison against Deribit DVOL and Binance realized vol — each one also wired into the agent's risk check, not just shown (details below).

---

## It actually works

This is not a mockup. The full loop runs end-to-end on Sui testnet:

```
connect wallet (Slush)
  -> see DeepEdge fair value
  -> choose UP / DOWN + strike
  -> confirm
  -> sign in wallet
  -> on-chain deposit + mint
  -> position appears in Portfolio
```

Real testnet transactions have been placed through this UI: DUSDC deposited into a PredictManager, UP and DOWN positions minted via a 2-step PTB (market_key::up|down, then predict::mint), and the resulting positions and realized P&L read back from the indexer. The minimum requirement "we will test the entire flow" is satisfied today.

---

## Honest analysis (the part most tools skip)

DeepEdge's calibration backtest is built to be *trustworthy*, not flattering.

**The headline finding** — over 831 settled bets (77 traders, extreme asks removed, no look-ahead: market ask at mint-time vs realized outcome):

| Implied range | n   | implied | actual | reading |
|---------------|-----|---------|--------|---------|
| 40-50%        | 210 | 46.6%   | 35.7%  | market over-prices by ~11% |
| 50-60%        | 363 | 53.2%   | 54.8%  | well-calibrated (+1.7%) |

Splitting by direction sharpens it: **near-even-money UP bets (40-50%, n=144) imply 46.7% but win only 34.0%** — a -12.7% gap. DeepBook Predict's testnet crowd is structurally bullish (about 70% of bets are UP), and it over-buys cheap UP positions. The 50-60% band is well-calibrated for both directions. Blind betting at the market ask returns about **-9%** (the spread).

**What we explicitly do not claim.** We also computed a Brier-score accuracy comparison that looked spectacular (83% "improvement"). We caught it as a **look-ahead artifact** — our fair value uses SVI observed about 5 seconds before settlement, by which point the forward is already ~99.9% of the settlement price. So that number measures SVI internal consistency, not predictive skill. We keep the endpoint but flag it openly and never present it as evidence of beating the market. Tail buckets (n<40) are labeled suggestive, not conclusive.

DeepEdge's real value is to **surface** where the market is reliable and where it is systematically off — not to promise profit on a thin testnet dataset.

---

### Arbitrage-free surface checks (butterfly + calendar)

![SVI smile with a live arbitrage-free badge (butterfly g(k) >= 0)](docs/screenshots/surface.png)

DeepEdge doesn't just read the SVI surface -- it checks the surface is
*coherent*. From the on-chain Gatheral SVI parameters it computes the
analytic first and second derivatives of total variance and evaluates
Gatheral's butterfly function g(k); the surface is butterfly-arbitrage-free
iff g(k) >= 0 across strikes. It also runs a calendar check across every
active maturity: total variance must be non-decreasing in time at fixed
log-moneyness. These derivatives are unit-tested against finite differences,
so the math is verified, not just asserted.

- `GET /api/markets/:id/surface-health` -- butterfly g(k) across strikes, with min g and an arbitrage-free flag
- `GET /api/surface/calendar-health` -- pairwise calendar check across all active oracles

And true to the rest of DeepEdge, it reports what it finds rather than
claiming perfection: on the current testnet the butterfly checks pass, while
the calendar check flags a handful of maturity pairs where the on-chain
surfaces aren't strictly monotone. We surface the violation count instead of
hiding it.

## Reading the market like a desk would

A raw SVI parameter set or a vault balance tells you nothing on its own. DeepEdge turns each into a single clear read, and -- unlike a read-only terminal -- feeds every one of them to the agent's Risk Officer as an input to the decision.

### Risk-neutral density (Breeden-Litzenberger)

From the SVI smile, DeepEdge computes the probability distribution the surface prices for where BTC settles, via Breeden-Litzenberger. The density reuses the *same* butterfly function g(k) used for the arbitrage check, so a surface that is butterfly-arbitrage-free is exactly one whose implied density is non-negative -- the analytic and the safety check are one object. Three unit tests verify the density is non-negative, integrates to ~1, and has a finite mode. The Density screen plots the distribution with the mode, P(up), and 90% range; the agent's two reviewers cross-check this density's P(up) against the model's fair value before any bet.

### Vault solvency grade

The PLP vault is the counterparty to every position, so its solvency is the market's solvency. DeepEdge grades it GREEN / AMBER / RED from its live on-chain reserves and exposure -- worst-case payout coverage (breach headroom), max-payout utilization, and exit liquidity -- with the numbers that justify the grade and unit tests for the boundaries. The Risk Officer is told to get more conservative when the vault is stressed: a strained counterparty is a reason to cut size or veto even when the edge looks fine.

### Cross-venue volatility

On-chain implied vol means little in isolation. DeepEdge frames Predict's ATM IV against Deribit's DVOL index and Binance's realized vol (an implied-vs-implied comparison at the tenor nearest 30 days), and computes the volatility risk premium -- Deribit implied minus Binance realized -- the spread that tells an LP whether selling vol carries an edge. If Predict drifts far rich or cheap versus Deribit, the Risk Officer treats the on-chain surface as suspect. References are pulled live; each leg degrades gracefully if a venue is unreachable.

Together these give the agent four independent signals -- historical calibration, the risk-neutral density, vault solvency, and the cross-venue vol comparison -- and every one of them is stored on Walrus and auditable in the ledger.

## The verifiable AI agent (built and working)

DeepEdge is not just a dashboard a human reads. The same fair-value
engine and calibration data drive an AI agent that *acts* -- and every
part of how it acts is constrained, recorded, and independently
verifiable. The analytics and the agent are two halves of one system:
the agent's judgement is only as good as the honest calibration beneath
it, and the calibration only matters if something acts on it safely.

Open the **AI Agent** screen and press **Run one cycle**. Live, in the
browser, you watch the full loop:

```
observe market + fair value + calibration
  -> Strategist agent proposes a bet (maximise EV)
  -> Risk Officer agent reviews it against calibration + limits
  -> store the full decision record on Walrus
  -> SHA-256 the record
  -> enforce the Mandate on-chain + record the decision
  -> fetch the blob back, re-hash, confirm it matches on-chain
```

### Two agents, and one can say no

![The AI agent loop: Strategist proposes, Risk Officer vetoes on calibration, Walrus stores, hash verifies, Mandate enforces](docs/screenshots/agent.png)

Two Claude agents split the decision. The **Strategist** proposes a bet
to maximise expected value. A separate **Risk Officer** reviews that
proposal against the historical calibration and the Mandate limits, and
can **veto** it outright.

This is where the honest calibration becomes a weapon. In a typical
run the Strategist proposes a maximum BET_DOWN, citing a ~4.5% edge.
The Risk Officer vetoes it:

> VETO. The model's probability falls in the 0.40-0.50 bucket where
> historical calibration shows actual outcomes occur only ~26% of the
> time versus ~47% implied, producing catastrophic negative ROI. The
> Strategist's apparent edge evaporates when calibrated.

One AI's optimism is caught by another AI armed with DeepEdge's own
record of where the market lies. No bet is placed.

### On-chain enforcement -- the hard rail

Below the agents sits a Move contract (`mandate`) that the agent
**cannot** talk its way around. Authorising a bet returns a
`BetReceipt` / `DecisionReceipt` -- a hot-potato with no `drop`
ability, so the transaction *must* record the spend and pass the
Mandate's checks or it does not execute at all. The Mandate enforces a
per-bet cap, a cumulative budget, and a kill switch.

These guarantees are not just tested -- they are **formally verified**.

- **7 Move unit tests** prove each safety property (over-cap aborts,
  over-budget aborts, kill switch rejects, decision-bound recording).
- **The Sui Prover** (Boogie + Z3) proves the core guarantee over ALL
  possible `u64` inputs, not just examples:

```move
#[spec(prove)]
fun authorize_respects_cap_spec(m: &Mandate, amount: u64): BetReceipt {
    requires(is_active(m));
    requires(amount <= per_bet_cap(m));
    requires(spent(m).to_int().add(amount.to_int())
               .lte(total_budget(m).to_int()));
    let r = authorize(m, amount);
    ensures(receipt_amount(&r) <= per_bet_cap(m));   // proven
    ensures(receipt_amount(&r) == amount);           // proven
    r
}
// Result: Verification successful
```

A successful `authorize()` can *never* return a receipt above the
per-bet cap -- mathematically, for every input. (During development the
prover even caught a real u64-overflow edge case in a naive
precondition, the kind of bug testing misses.)

### Real bets, bound to the decision

The agent does not bet against a toy contract. One PTB composes the
Mandate with the **real DeepBook Predict** `predict::mint`:

```
mandate::authorize_with_decision(amount, hash, blob_id) -> receipt
market_key::down(oracle, expiry, strike) -> mkey
predict::mint<DUSDC>(Predict, Manager, oracle, mkey, qty, clock)
mandate::record_decision_and_consume(receipt)
```

Because the receipt is a hot-potato, a real on-chain position cannot be
minted without passing the Mandate's checks *and* recording the
calibration-aware, Walrus-stored, hash-anchored decision in the same
transaction. Real positions have been minted this way on testnet.

### Verifiable memory on Walrus

Every decision -- the market it saw, both agents' reasoning, the chosen
size -- is written to **Walrus** and its SHA-256 hash is emitted
on-chain in a `DecisionRecorded` event. Anyone can fetch the blob,
re-hash it, and confirm it matches the on-chain hash. The agent has a
tamper-proof, auditable memory: you can prove exactly *why* any past
position was taken. This is the accountability real financial decisions
demand.

### The ledger: every decision, auditable forever

![Agent Performance Ledger -- every decision auditable, hash re-verified in-browser](docs/screenshots/ledger.png)

Each cycle -- whether it ends in a bet, a veto, or a no-bet -- is appended
to a persistent ledger with the market observed, both agents' reasoning,
the outcome, and the Walrus blob id + SHA-256 of the full decision record.
The **Ledger** screen renders this history with a per-entry *Verify hash*
button: your browser re-fetches the blob from Walrus, re-hashes it, and
confirms it matches -- client-side, no trust required. The summary shows
how much capital the Risk Officer's vetoes protected.

This is the difference between an agent that trades and an agent you can
hold accountable: not just *what* it did, but *why*, provably, for every
single decision it ever made.

### Telegram notifications (non-custodial, alert-only)

The agent can push every decision to Telegram the moment it happens -- the
market, the Risk Officer's verdict, the Walrus blob, and a link to verify
the hash yourself. This is deliberately the opposite of a custodial trading
bot: DeepEdge never holds your funds and never trades on your behalf from a
chat. The notification only makes the agent's reasoning visible and
checkable in real time. Credentials live in a chmod-600 env file and are
git-ignored.

### On-chain proof (testnet)

- Mandate package: `0xb82750b35a213320d5ad6204e7bce46493ae76340e2a018fd65fdca4ad08f34a`
- Mandate object: `0x753fb2e637d42067aeea59df6044ddfeb37ac22c92f28c89a8ffc6e3a4635f3a`
- Example verifiable-loop cycle: digest `9HZVqeiYsEHQdwh8FGwnKvC9Z3f5Vf9TPrBhvK67QUGc`
- Real DeepBook Predict positions minted on testnet, including via the atomic Mandate + `predict::mint` PTB


---

## Nine screens

- **Markets** — every live BTC market with DeepEdge's UP/DOWN fair value and implied vol on each card, sorted by expiry, flagging the largest-edge market, the calibration-caution bucket, and any stale on-chain price.
- **Market detail** — the SVI volatility smile, a full fair-probability table by strike, live auto-refresh every 30s, and the bet panel.
- **Insights** — the calibration backtest, visualized: where the market is mispriced, by direction.
- **Density** — the risk-neutral distribution the SVI surface prices, plotted, with mode, P(up), and 90% range; the same g(k) as the arbitrage check.
- **Vault** — the PLP vault's solvency grade (GREEN / AMBER / RED) with worst-case payout coverage, utilization, and exit liquidity; the same read the Risk Officer uses.
- **Cross-Venue** — Predict's ATM IV against Deribit DVOL and Binance realized vol, with the rich/cheap verdict and the volatility risk premium.
- **Portfolio** — your on-chain betting history, account value, and realized P&L.
- **AI Agent** — the verifiable autonomous loop, live: press *Run one cycle* and watch the Strategist propose, the Risk Officer veto, the decision land on Walrus, the hash verify, and the Mandate enforce — all on-chain.
- **Ledger** — the agent's entire decision history, auditable: every cycle (bet, veto, or no-bet) with both agents' reasoning, its Walrus blob and SHA-256, and a *Verify hash* button that re-fetches the blob and re-checks the hash in your browser. A trading bot says "trust me"; this page says "check me".

**Insights** — the calibration backtest, visualized:

![Calibration insights](docs/screenshots/insights.png)

**Portfolio** — real on-chain positions and P&L:

![Portfolio](docs/screenshots/portfolio.png)

---

## Tech stack

- **Fair-value engine:** Rust (Axum + Tokio). SVI total-variance model, log-normal binary pricing, calibration and accuracy backtests. About 20 logic tests.
- **Frontend:** Next.js 14 (App Router), TailwindCSS, @mysten/dapp-kit for wallet connection and transaction signing, Recharts for the smile.
- **On-chain:** DeepBook Predict on Sui testnet — predict::mint, predict_manager::deposit, market_key::up|down, DUSDC quote asset.
- **Data:** the public Predict indexer (predict-server.testnet.mystenlabs.com) plus direct Sui RPC.
- **Infrastructure:** a self-hosted Sui mainnet full node (8ms vs ~123ms public-RPC latency), run since before the hackathon.

---

## API

Rust backend (port 3000):

- `GET /api/markets` — all DeepBook Predict BTC oracles
- `GET /api/markets/:oracle_id/strikes` — per-strike fair UP/DOWN from the SVI smile
- `GET /api/markets/:oracle_id/edges` — fair vs market ask, where order-flow exists
- `GET /api/backtest/calibration` — the calibration report above
- `GET /api/manager?owner=` — discover a wallet's PredictManager
- `GET /api/manager/positions?manager=` — a manager's bet history
- `GET /api/manager/summary?manager=` — account value, realized P&L, balance

---

## Roadmap to mainnet

DeepBook Predict launches on mainnet in Q3, and hackathon projects are expected to redeploy on day one. DeepEdge is built for that day:

- **Day-one redeploy** via the self-hosted mainnet node — the latency edge matters most when real order-flow arrives.
- **Edge ranking.** On testnet, live order-flow is too thin to rank markets by fair-vs-market edge (we verified: market quotes are near-zero across active markets, so this would be vapor). On mainnet, with real participants, DeepEdge will rank the most mispriced bets in real time — the natural extension of the calibration work.
- **Deeper position analytics** as settled history accumulates.

### What's next

The verifiable AI agent above is built and working on testnet today. The
natural next steps: rank the most mispriced markets in real time once
mainnet order-flow is live, let the agent learn from its own settled
outcomes (its Walrus memory makes this auditable), and extend the
formal-verification specs to cover the budget and recording invariants as
well as the per-bet cap.


---

## Author

**Iwao Kai** — Rust/Move engineer, self-hosted Sui node operator. GitHub: IWAOKAI

## License

MIT
