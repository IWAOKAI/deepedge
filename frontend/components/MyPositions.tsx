"use client";

import { useEffect, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { api, PositionMint, PositionRange, PositionRedeemed, RangeRedeemed, ManagerSummary } from "@/lib/api";
import { buildRedeemTx, buildRedeemRangeTx, PREDICT_PACKAGE, PREDICT_ID, CLOCK_ID } from "@/lib/transactions";

export function MyPositions({ oracleId }: { oracleId?: string }) {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const client = useSuiClient();
  // Close confirmation: which position is pending, and the live quote for it.
  const [confirmClose, setConfirmClose] = useState<
    | { kind: "binary"; pos: PositionMint }
    | { kind: "range"; pos: PositionRange }
    | null
  >(null);
  const [quote, setQuote] = useState<{ bid: number; cost: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [positions, setPositions] = useState<PositionMint[] | null>(null);
  const [ranges, setRanges] = useState<PositionRange[]>([]);
  const [posRedeemed, setPosRedeemed] = useState<PositionRedeemed[]>([]);
  const [rangeRedeemed, setRangeRedeemed] = useState<RangeRedeemed[]>([]);
  const [summary, setSummary] = useState<ManagerSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [managerId, setManagerId] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Ask the chain what this position is worth right now (the live bid), so the
  // user sees their realized P&L before confirming. Falls back to cost-only if
  // the dev-inspect quote fails.
  async function requestClose(
    target:
      | { kind: "binary"; pos: PositionMint }
      | { kind: "range"; pos: PositionRange }
  ) {
    setConfirmClose(target);
    setQuote(null);
    if (!account) return;
    setQuoting(true);
    try {
      const tx = new Transaction();
      if (target.kind === "binary") {
        const p = target.pos;
        const key = tx.moveCall({
          target: `${PREDICT_PACKAGE}::market_key::${p.is_up ? "up" : "down"}`,
          arguments: [
            tx.pure.id(p.oracle_id),
            tx.pure.u64(BigInt(p.expiry)),
            tx.pure.u64(BigInt(Math.round(p.strike))),
          ],
        });
        tx.moveCall({
          target: `${PREDICT_PACKAGE}::predict::get_trade_amounts`,
          arguments: [
            tx.object(PREDICT_ID),
            tx.object(p.oracle_id),
            key,
            tx.pure.u64(BigInt(p.quantity)),
            tx.object(CLOCK_ID),
          ],
        });
      } else {
        const r = target.pos;
        const key = tx.moveCall({
          target: `${PREDICT_PACKAGE}::range_key::new`,
          arguments: [
            tx.pure.id(r.oracle_id),
            tx.pure.u64(BigInt(r.expiry)),
            tx.pure.u64(BigInt(Math.round(r.lower_strike))),
            tx.pure.u64(BigInt(Math.round(r.higher_strike))),
          ],
        });
        tx.moveCall({
          target: `${PREDICT_PACKAGE}::predict::get_range_trade_amounts`,
          arguments: [
            tx.object(PREDICT_ID),
            tx.object(r.oracle_id),
            key,
            tx.pure.u64(BigInt(r.quantity)),
            tx.object(CLOCK_ID),
          ],
        });
      }
      const res = await client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: account.address,
      });
      // The trade-amounts call returns (ask, bid). Find the call's return
      // values and decode the second u64 (bid) as a little-endian number.
      const calls = res.results ?? [];
      const last = calls[calls.length - 1];
      const rv = last?.returnValues ?? [];
      const decodeU64 = (bytes: number[]) => {
        let n = 0n;
        for (let i = 0; i < bytes.length; i++) n += BigInt(bytes[i]) << (8n * BigInt(i));
        return Number(n);
      };
      const bidRaw = rv.length >= 2 ? decodeU64(rv[1][0] as number[]) : 0;
      const cost = target.pos.cost / 1e6;
      setQuote({ bid: bidRaw / 1e6, cost });
    } catch (e) {
      console.error("quote failed", e);
      setQuote(null);
    } finally {
      setQuoting(false);
    }
  }

  // Run the actual redeem after the user confirms.
  async function doClose() {
    if (!confirmClose) return;
    const target = confirmClose;
    setConfirmClose(null);
    if (target.kind === "binary") {
      await closeBinary(target.pos);
    } else {
      await closeRange(target.pos);
    }
    setQuote(null);
  }

  // Close (redeem) a binary position. Before settlement this pays the live
  // bid — an early exit. After settlement it pays the $1/$0 outcome.
  async function closeBinary(pp: PositionMint) {
    if (!managerId) return;
    setClosing(pp.digest);
    try {
      const tx = buildRedeemTx({
        managerId,
        oracleId: pp.oracle_id,
        expiry: BigInt(pp.expiry),
        strike: BigInt(Math.round(pp.strike)),
        isUp: pp.is_up,
        quantity: BigInt(pp.quantity),
      });
      await signAndExecute({ transaction: tx });
      setReloadKey((k) => k + 1);
    } catch (e) {
      console.error("close failed", e);
    } finally {
      setClosing(null);
    }
  }

  async function closeRange(rr: PositionRange) {
    if (!managerId) return;
    setClosing(rr.digest);
    try {
      const tx = buildRedeemRangeTx({
        managerId,
        oracleId: rr.oracle_id,
        expiry: BigInt(rr.expiry),
        lowerStrike: BigInt(Math.round(rr.lower_strike)),
        higherStrike: BigInt(Math.round(rr.higher_strike)),
        quantity: BigInt(rr.quantity),
      });
      await signAndExecute({ transaction: tx });
      setReloadKey((k) => k + 1);
    } catch (e) {
      console.error("close range failed", e);
    } finally {
      setClosing(null);
    }
  }

  useEffect(() => {
    if (!account) {
      setPositions(null);
      setSummary(null);
      setRanges([]);
      setPosRedeemed([]);
      setRangeRedeemed([]);
      return;
    }
    setLoading(true);
    api
      .manager(account.address)
      .then(async (events) => {
        if (events.length === 0) {
          setPositions([]);
          setRanges([]);
          setPosRedeemed([]);
          setRangeRedeemed([]);
          return;
        }
        const mid = events[0].manager_id;
        setManagerId(mid);
        // Positions and summary are fetched independently: the Predict
        // server's summary endpoint can 500 (e.g. "missing mark quote
        // results" near expiry), and we must not let that wipe out the
        // positions list — the bets are real and indexed regardless.
        const pos = await api.positions(mid);
        setPositions(pos.minted ?? []);
        setPosRedeemed(pos.redeemed ?? []);
        // Range positions live on a separate endpoint; fetch independently so
        // a range failure never wipes the binary positions, and vice versa.
        try {
          const rng = await api.ranges(mid);
          setRanges(rng.minted ?? []);
          setRangeRedeemed(rng.redeemed ?? []);
        } catch {
          setRanges([]);
        }
        try {
          const sum = await api.summary(mid);
          setSummary(sum);
        } catch {
          // Balance/summary unavailable (server-side); positions still show.
          setSummary(null);
        }
      })
      .catch(() => setPositions([]))
      .finally(() => setLoading(false));
  }, [account, reloadKey]);

  if (!account) return null;
  if (loading && positions === null) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <p style={{ color: "var(--text-muted)", margin: 0 }}>Loading your positions...</p>
      </div>
    );
  }
  if ((!positions || positions.length === 0) && ranges.length === 0) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 6px" }}>My positions</h2>
        <p style={{ color: "var(--text-muted)", margin: 0, fontSize: 13 }}>
          No bets yet. Place one above and it will appear here.
        </p>
      </div>
    );
  }

  // optionally filter to this market; otherwise show all.
  // positions may be null here when only range positions exist, so default to [].
  // "minted" is an event log, so a position stays in it even after it's
  // redeemed. The live holding is minted minus what's already been redeemed
  // (matched on oracle + strike + direction), so a closed position drops off.
  const openPositions = (positions ?? []).filter((p) => {
    const redeemedQty = posRedeemed
      .filter(
        (r) =>
          r.oracle_id === p.oracle_id &&
          r.strike === p.strike &&
          r.is_up === p.is_up
      )
      .reduce((sum, r) => sum + r.quantity, 0);
    return p.quantity > redeemedQty;
  });
  const openRanges = ranges.filter((r) => {
    const redeemedQty = rangeRedeemed
      .filter(
        (x) =>
          x.oracle_id === r.oracle_id &&
          x.lower_strike === r.lower_strike &&
          x.higher_strike === r.higher_strike
      )
      .reduce((sum, x) => sum + x.quantity, 0);
    return r.quantity > redeemedQty;
  });

  const shown = oracleId
    ? openPositions.filter((p) => p.oracle_id === oracleId)
    : openPositions;
  const list = shown.length > 0 ? shown : openPositions;
  const scopedToMarket = oracleId ? shown.length > 0 : false;

  // Closed positions: pair each redemption with its original cost (matched on
  // oracle + strike + direction) so we can show realized P&L. payout − cost.
  const closedBinary = posRedeemed.map((r) => {
    const orig = (positions ?? []).find(
      (p) => p.oracle_id === r.oracle_id && p.strike === r.strike && p.is_up === r.is_up
    );
    const cost = orig ? orig.cost : 0;
    return { ...r, cost, pnl: r.payout - cost };
  });
  const closedRange = rangeRedeemed.map((r) => {
    const orig = ranges.find(
      (x) =>
        x.oracle_id === r.oracle_id &&
        x.lower_strike === r.lower_strike &&
        x.higher_strike === r.higher_strike
    );
    const cost = orig ? orig.cost : 0;
    return { ...r, cost, pnl: r.payout - cost };
  });
  const hasClosed = closedBinary.length > 0 || closedRange.length > 0;

  const dusdc = summary?.balances?.find((b) => b.quote_asset.includes("dusdc"));
  const pnl = (summary?.realized_pnl ?? 0) / 1e6;

  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>My positions</h2>
        {summary && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Account{" "}
            <strong style={{ color: "var(--primary-dark)" }}>
              ${(summary.account_value / 1e6).toFixed(2)}
            </strong>
            {" · "}Realized P&amp;L{" "}
            <strong style={{ color: pnl >= 0 ? "var(--up)" : "var(--down)" }}>
              {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
            </strong>
          </div>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px" }}>
        {scopedToMarket
          ? "Your bets on this market."
          : "Your bets across all markets."}{" "}
        {dusdc ? `Manager balance $${(dusdc.balance / 1e6).toFixed(2)}.` : ""}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list
          .slice()
          .sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms)
          .map((p) => {
            const filled = (p.ask_price / 1e9) * 100;
            const cost = p.cost / 1e6;
            const qty = p.quantity / 1e6;
            const when = new Date(p.checkpoint_timestamp_ms);
            return (
              <div
                key={p.digest}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "#f8fafc",
                  border: "1px solid var(--border)",
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      color: "white",
                      background: p.is_up ? "var(--up)" : "var(--down)",
                    }}
                  >
                    {p.is_up ? "UP" : "DOWN"}
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    ${(p.strike / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <a
                    href={`https://testnet.suivision.xyz/txblock/${p.digest}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 11, color: "var(--primary)" }}
                  >
                    tx
                  </a>
                </div>
                <div style={{ display: "flex", gap: 16, color: "var(--text-muted)" }}>
                  <span>
                    ${qty.toFixed(0)} @ <strong>{filled.toFixed(0)}%</strong>
                  </span>
                  <span>cost ${cost.toFixed(2)}</span>
                  <span style={{ fontSize: 11 }}>
                    {when.toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                  <button
                    onClick={() => requestClose({ kind: "binary", pos: p })}
                    disabled={closing !== null}
                    style={closeBtnStyle}
                  >
                    {closing === p.digest ? "Closing…" : "Close"}
                  </button>
                </div>
              </div>
            );
          })}
      </div>

      {openRanges.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Range positions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {openRanges
              .slice()
              .sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms)
              .map((r) => {
                const lo = r.lower_strike / 1e9;
                const hi = r.higher_strike / 1e9;
                const cost = r.cost / 1e6;
                const qty = r.quantity / 1e6;
                const when = new Date(r.checkpoint_timestamp_ms);
                return (
                  <div
                    key={r.digest}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: "#f8fafc",
                      border: "1px solid var(--border)",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: 12,
                          padding: "2px 8px",
                          borderRadius: 999,
                          color: "white",
                          background: "var(--primary-dark)",
                        }}
                      >
                        RANGE
                      </span>
                      <span style={{ fontWeight: 600 }}>
                        ${lo.toLocaleString(undefined, { maximumFractionDigits: 0 })}–$
                        {hi.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                      <a
                        href={`https://testnet.suivision.xyz/txblock/${r.digest}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, color: "var(--primary)" }}
                      >
                        tx
                      </a>
                    </div>
                    <div style={{ display: "flex", gap: 16, color: "var(--text-muted)" }}>
                      <span>${qty.toFixed(0)} qty</span>
                      <span>cost ${cost.toFixed(2)}</span>
                      <span style={{ fontSize: 11 }}>
                        {when.toLocaleDateString([], { month: "short", day: "numeric" })}
                      </span>
                      <button
                        onClick={() => requestClose({ kind: "range", pos: r })}
                        disabled={closing !== null}
                        style={closeBtnStyle}
                      >
                        {closing === r.digest ? "Closing…" : "Close"}
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {hasClosed && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Closed positions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...closedBinary.map((r) => ({ ...r, kind: "binary" as const })),
              ...closedRange.map((r) => ({ ...r, kind: "range" as const }))]
              .sort((a, b) => b.checkpoint_timestamp_ms - a.checkpoint_timestamp_ms)
              .map((r) => {
                const payout = r.payout / 1e6;
                const cost = r.cost / 1e6;
                const pnlUsd = r.pnl / 1e6;
                const up = pnlUsd >= 0;
                const label =
                  r.kind === "range"
                    ? `RANGE $${((r as RangeRedeemed).lower_strike / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}–$${((r as RangeRedeemed).higher_strike / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                    : `${(r as PositionRedeemed).is_up ? "UP" : "DOWN"} $${((r as PositionRedeemed).strike / 1e9).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
                return (
                  <div
                    key={r.digest}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 12px",
                      borderRadius: 10,
                      background: "#fafafa",
                      border: "1px solid var(--border)",
                      fontSize: 13,
                      opacity: 0.85,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {r.is_settled ? "settled" : "early exit"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 16, color: "var(--text-muted)" }}>
                      <span>got ${payout.toFixed(2)}</span>
                      <span>cost ${cost.toFixed(2)}</span>
                      <span style={{ fontWeight: 700, color: up ? "var(--up)" : "var(--down)" }}>
                        {up ? "+" : "−"}${Math.abs(pnlUsd).toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
      {confirmClose && (
        <div
          onClick={() => { setConfirmClose(null); setQuote(null); }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: 14,
              padding: 22,
              width: 360,
              maxWidth: "90vw",
              boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
              Close this position?
            </div>
            {quoting ? (
              <div style={{ fontSize: 14, color: "var(--text-muted)" }}>
                Fetching the current market price…
              </div>
            ) : quote ? (
              <div style={{ fontSize: 14, lineHeight: 1.7 }}>
                Sell now for{" "}
                <strong>${quote.bid.toFixed(2)}</strong>. You paid{" "}
                <strong>${quote.cost.toFixed(2)}</strong>, so you&apos;ll realize{" "}
                <strong
                  style={{
                    color: quote.bid - quote.cost >= 0 ? "var(--up)" : "var(--down)",
                  }}
                >
                  {quote.bid - quote.cost >= 0 ? "+" : "−"}$
                  {Math.abs(quote.bid - quote.cost).toFixed(2)}
                </strong>
                .
              </div>
            ) : (
              <div style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-muted)" }}>
                This closes at the current market price. You paid $
                {(confirmClose.pos.cost / 1e6).toFixed(2)}.
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setConfirmClose(null); setQuote(null); }}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={doClose}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--primary-dark)",
                  color: "white",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Confirm close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const closeBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
