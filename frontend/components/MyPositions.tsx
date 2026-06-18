"use client";

import { useEffect, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { api, PositionMint, PositionRange, ManagerSummary } from "@/lib/api";

export function MyPositions({ oracleId }: { oracleId?: string }) {
  const account = useCurrentAccount();
  const [positions, setPositions] = useState<PositionMint[] | null>(null);
  const [ranges, setRanges] = useState<PositionRange[]>([]);
  const [summary, setSummary] = useState<ManagerSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!account) {
      setPositions(null);
      setSummary(null);
      setRanges([]);
      return;
    }
    setLoading(true);
    api
      .manager(account.address)
      .then(async (events) => {
        if (events.length === 0) {
          setPositions([]);
          setRanges([]);
          return;
        }
        const mid = events[0].manager_id;
        // Positions and summary are fetched independently: the Predict
        // server's summary endpoint can 500 (e.g. "missing mark quote
        // results" near expiry), and we must not let that wipe out the
        // positions list — the bets are real and indexed regardless.
        const pos = await api.positions(mid);
        setPositions(pos.minted ?? []);
        // Range positions live on a separate endpoint; fetch independently so
        // a range failure never wipes the binary positions, and vice versa.
        try {
          const rng = await api.ranges(mid);
          setRanges(rng.minted ?? []);
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
  }, [account]);

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
  const safePositions = positions ?? [];
  const shown = oracleId
    ? safePositions.filter((p) => p.oracle_id === oracleId)
    : safePositions;
  const list = shown.length > 0 ? shown : safePositions;
  const scopedToMarket = oracleId ? shown.length > 0 : false;

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
                </div>
              </div>
            );
          })}
      </div>

      {ranges.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Range positions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ranges
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
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
