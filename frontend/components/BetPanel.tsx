"use client";

import React, { useEffect, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { api, ManagerEvent } from "@/lib/api";
import { buildDepositTx, buildMintTx, buildRangeMintTx } from "@/lib/transactions";

interface BetPanelProps {
  oracleId: string;
  expiry: number;
  atmStrike: number;
  strikes: { strike_usd: number; fair_up: number; fair_down: number }[];
}

type Status =
  | { kind: "idle" }
  | { kind: "working"; msg: string }
  | { kind: "ok"; msg: string; digest?: string }
  | { kind: "error"; msg: string };

export function BetPanel({ oracleId, expiry, atmStrike, strikes }: BetPanelProps) {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [managerId, setManagerId] = useState<string | null>(null);
  const [managerChecked, setManagerChecked] = useState(false);
  const [mgrBalance, setMgrBalance] = useState<number | null>(null);

  const [selectedStrike, setSelectedStrike] = useState<number>(atmStrike);
  const [isUp, setIsUp] = useState(true);
  const [mode, setMode] = useState<"binary" | "range">("binary");
  const [lowerStrike, setLowerStrike] = useState<number>(atmStrike);
  const [higherStrike, setHigherStrike] = useState<number>(atmStrike);
  const [betUsd, setBetUsd] = useState("5");
  const [depositUsd, setDepositUsd] = useState("10");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showConfirm, setShowConfirm] = useState(false);

  async function refreshBalance(mid: string) {
    try {
      const summary = await fetch(
        `https://predict-server.testnet.mystenlabs.com/managers/${mid}/summary`
      ).then((r) => r.json());
      const dusdc = summary?.balances?.find(
        (entry: { quote_asset?: string; balance?: number }) =>
          entry.quote_asset?.includes("dusdc")
      );
      setMgrBalance((dusdc?.balance ?? 0) / 1e6);
    } catch {
      setMgrBalance(null);
    }
  }

  useEffect(() => {
    if (!account) {
      setManagerChecked(false);
      setManagerId(null);
      return;
    }
    api
      .manager(account.address)
      .then(async (events: ManagerEvent[]) => {
        if (events.length > 0) {
          setManagerId(events[0].manager_id);
          await refreshBalance(events[0].manager_id);
        } else {
          setManagerId(null);
        }
      })
      .catch(() => setManagerId(null))
      .finally(() => setManagerChecked(true));
  }, [account]);

  // when market data refreshes (strikes shift with BTC price),
  // keep the selected strike valid by snapping to the nearest available one
  useEffect(() => {
    if (strikes.length === 0) return;
    const exists = strikes.some((s) => Math.abs(s.strike_usd - selectedStrike) < 0.5);
    if (!exists) {
      const nearest = strikes.reduce((best, s) =>
        Math.abs(s.strike_usd - selectedStrike) < Math.abs(best.strike_usd - selectedStrike)
          ? s
          : best
      , strikes[0]);
      setSelectedStrike(nearest.strike_usd);
    }
  }, [strikes, selectedStrike]);

  // Initialize range bounds to straddle the ATM strike (one tick below/above),
  // so the band has non-zero width and a probability shows immediately.
  useEffect(() => {
    if (strikes.length < 2) return;
    const sorted = [...strikes].sort((a, b) => a.strike_usd - b.strike_usd);
    const atmIdx = sorted.reduce(
      (bi, s, i) =>
        Math.abs(s.strike_usd - atmStrike) < Math.abs(sorted[bi].strike_usd - atmStrike) ? i : bi,
      0
    );
    const lo = sorted[Math.max(0, atmIdx - 10)];
    const hi = sorted[Math.min(sorted.length - 1, atmIdx + 10)];
    if (lo && hi && lo.strike_usd < hi.strike_usd) {
      setLowerStrike(lo.strike_usd);
      setHigherStrike(hi.strike_usd);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strikes]);

  async function handleDeposit() {
    const amount = BigInt(Math.round(parseFloat(depositUsd) * 1e6));
    if (amount <= 0n || !managerId) return;
    setStatus({ kind: "working", msg: "Depositing DUSDC..." });
    try {
      const tx = buildDepositTx({ managerId, amount });
      const result = await signAndExecute({ transaction: tx });
      setStatus({ kind: "ok", msg: `Deposited $${depositUsd}`, digest: result.digest });
      await refreshBalance(managerId);
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error).message ?? "Deposit failed" });
    }
  }

  async function handleBet() {
    const quantity = BigInt(Math.round(parseFloat(betUsd) * 1e6));
    if (quantity <= 0n || !managerId) return;
    // Guard: don't submit a bet that exceeds the manager's DUSDC balance,
    // otherwise the on-chain mint reverts and the user only sees a cryptic error.
    const betAmount = parseFloat(betUsd);
    if (mgrBalance !== null && betAmount > mgrBalance) {
      setStatus({
        kind: "error",
        msg: `Insufficient balance: you have $${mgrBalance.toFixed(2)} but are betting $${betAmount.toFixed(2)}. Deposit more DUSDC first.`,
      });
      setShowConfirm(false);
      return;
    }
    // Range bets need a valid band (lower < higher) before we build the tx.
    if (mode === "range" && lowerStrike >= higherStrike) {
      setStatus({
        kind: "error",
        msg: `Lower strike ($${lowerStrike.toLocaleString()}) must be below higher strike ($${higherStrike.toLocaleString()}).`,
      });
      setShowConfirm(false);
      return;
    }
    setShowConfirm(false);
    setStatus({ kind: "working", msg: "Placing bet..." });
    try {
      const tx =
        mode === "range"
          ? buildRangeMintTx({
              managerId,
              oracleId,
              expiry: BigInt(expiry),
              lowerStrike: BigInt(Math.round(lowerStrike * 1e9)),
              higherStrike: BigInt(Math.round(higherStrike * 1e9)),
              quantity,
            })
          : buildMintTx({
              managerId,
              oracleId,
              expiry: BigInt(expiry),
              strike: BigInt(Math.round(selectedStrike * 1e9)),
              isUp,
              quantity,
            });
      const result = await signAndExecute({ transaction: tx });
      setStatus({
        kind: "ok",
        msg:
          mode === "range"
            ? `Range bet placed: $${lowerStrike.toLocaleString()}–$${higherStrike.toLocaleString()}`
            : `Bet placed: ${isUp ? "UP" : "DOWN"} $${selectedStrike.toLocaleString()}`,
        digest: result.digest,
      });
      await refreshBalance(managerId);
    } catch (e) {
      setStatus({ kind: "error", msg: (e as Error).message ?? "Bet failed" });
    }
  }

  if (!account) {
    return <Panel><Muted>Connect your wallet to bet on this market.</Muted></Panel>;
  }
  if (!managerChecked) {
    return <Panel><Muted>Checking your PredictManager...</Muted></Panel>;
  }
  if (!managerId) {
    return (
      <Panel>
        <p style={{ margin: "0 0 8px", fontWeight: 600 }}>No PredictManager found</p>
        <Muted>You need a PredictManager to bet. Create one via the DeepBook Predict app for now.</Muted>
      </Panel>
    );
  }

  const selectedRow =
    strikes.find((s) => Math.abs(s.strike_usd - selectedStrike) < 0.5) ??
    strikes.reduce((best, s) =>
      Math.abs(s.strike_usd - selectedStrike) < Math.abs(best.strike_usd - selectedStrike)
        ? s
        : best
    , strikes[0]);
  const fairPct = selectedRow
    ? ((isUp ? selectedRow.fair_up : selectedRow.fair_down) * 100).toFixed(1)
    : "-";

  // Range fair value = P(settle < higher) - P(settle < lower)
  //                  = fair_down(higher) - fair_down(lower).
  const lowerRow = strikes.reduce(
    (best, s) =>
      Math.abs(s.strike_usd - lowerStrike) < Math.abs(best.strike_usd - lowerStrike) ? s : best,
    strikes[0]
  );
  const higherRow = strikes.reduce(
    (best, s) =>
      Math.abs(s.strike_usd - higherStrike) < Math.abs(best.strike_usd - higherStrike) ? s : best,
    strikes[0]
  );
  const rangeFairPct =
    lowerRow && higherRow && higherStrike > lowerStrike
      ? Math.max(0, (higherRow.fair_down - lowerRow.fair_down) * 100).toFixed(1)
      : "-";

  return (
    <Panel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Place a bet</h2>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Manager balance:{" "}
          <strong style={{ color: "var(--primary-dark)" }}>
            {managerId === null
              ? "no manager yet"
              : mgrBalance === null
              ? "…"
              : `$${mgrBalance.toFixed(2)}`}
          </strong>
        </span>
      </div>

      <div style={{ marginBottom: 18, paddingBottom: 18, borderBottom: "1px solid var(--border)" }}>
        <label style={{ fontSize: 13, color: "var(--text-muted)" }}>Deposit DUSDC into your manager</label>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input type="number" value={depositUsd} onChange={(e) => setDepositUsd(e.target.value)} style={inputStyle} />
          <button onClick={handleDeposit} style={secondaryBtn}>Deposit</button>
        </div>
      </div>

      {/* UP / DOWN / RANGE — three peer choices on one row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button
          onClick={() => { setMode("binary"); setIsUp(true); }}
          style={mode === "binary" && isUp ? upBtnActive : upBtn}
        >
          UP
        </button>
        <button
          onClick={() => { setMode("binary"); setIsUp(false); }}
          style={mode === "binary" && !isUp ? downBtnActive : downBtn}
        >
          DOWN
        </button>
        <button
          onClick={() => {
            setMode("range");
            if (strikes.length >= 2 && lowerStrike >= higherStrike) {
              const sorted = [...strikes].sort((a, b) => a.strike_usd - b.strike_usd);
              let atmIdx = 0;
              for (let i = 0; i < sorted.length; i++) {
                if (Math.abs(sorted[i].strike_usd - atmStrike) < Math.abs(sorted[atmIdx].strike_usd - atmStrike)) {
                  atmIdx = i;
                }
              }
              const lo = sorted[Math.max(0, atmIdx - 10)];
              const hi = sorted[Math.min(sorted.length - 1, atmIdx + 10)];
              if (lo && hi && lo.strike_usd < hi.strike_usd) {
                setLowerStrike(lo.strike_usd);
                setHigherStrike(hi.strike_usd);
              }
            }
          }}
          style={mode === "range" ? rangeBtnActive : rangeBtn}
        >
          RANGE
        </button>
      </div>

      {mode === "binary" ? (
        <>

          <label style={{ fontSize: 13, color: "var(--text-muted)" }}>Strike</label>
          <select
            value={selectedStrike}
            onChange={(e) => setSelectedStrike(parseFloat(e.target.value))}
            style={{ ...inputStyle, width: "100%", marginTop: 6, marginBottom: 14 }}
          >
            {strikes.map((s) => (
              <option key={s.strike_usd} value={s.strike_usd}>
                ${s.strike_usd.toLocaleString()}{Math.abs(s.strike_usd - atmStrike) < 1 ? " (current price)" : ""}
              </option>
            ))}
          </select>

          <div
            style={{
              marginBottom: 14,
              padding: 12,
              borderRadius: 10,
              background: "#f0f9ff",
              border: "1px solid #bae6fd",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
              DeepEdge fair value for {isUp ? "UP" : "DOWN"} @ ${selectedStrike.toLocaleString()}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <strong style={{ fontSize: 24, color: isUp ? "var(--up)" : "var(--down)" }}>
                {fairPct}%
              </strong>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                model probability BTC settles {isUp ? "above" : "below"} this strike
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
              A fair bet pays out at this probability. Bet when the market price is
              cheaper than fair.
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, color: "var(--text-muted)" }}>Lower</label>
              <select
                value={lowerStrike}
                onChange={(e) => setLowerStrike(parseFloat(e.target.value))}
                style={{ ...inputStyle, width: "100%", marginTop: 6 }}
              >
                {strikes.map((s) => (
                  <option key={s.strike_usd} value={s.strike_usd}>
                    ${s.strike_usd.toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, color: "var(--text-muted)" }}>Higher</label>
              <select
                value={higherStrike}
                onChange={(e) => setHigherStrike(parseFloat(e.target.value))}
                style={{ ...inputStyle, width: "100%", marginTop: 6 }}
              >
                {strikes.map((s) => (
                  <option key={s.strike_usd} value={s.strike_usd}>
                    ${s.strike_usd.toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            style={{
              marginBottom: 14,
              padding: 12,
              borderRadius: 10,
              background: "#f0f9ff",
              border: "1px solid #bae6fd",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
              DeepEdge fair value for RANGE ${lowerStrike.toLocaleString()}–${higherStrike.toLocaleString()}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <strong style={{ fontSize: 24, color: "var(--primary-dark)" }}>
                {rangeFairPct}%
              </strong>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                model probability BTC settles within this band
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
              A vertical range priced as one instrument. Your loss is capped by the band.
            </div>
          </div>
        </>
      )}

      <label style={{ fontSize: 13, color: "var(--text-muted)" }}>Bet amount (DUSDC)</label>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <input type="number" value={betUsd} onChange={(e) => setBetUsd(e.target.value)} style={inputStyle} />
        <button onClick={() => setShowConfirm(true)} style={primaryBtn}>BET !</button>
      </div>

      {showConfirm && (
        <div
          style={{
            marginTop: 14,
            padding: 16,
            borderRadius: 12,
            background: "#fffbeb",
            border: "1px solid #fcd34d",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
            Confirm your bet
          </div>
          <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 4 }}>
            Betting{" "}
            <strong>${betUsd} DUSDC</strong> on{" "}
            <strong style={{ color: isUp ? "var(--up)" : "var(--down)" }}>
              {isUp ? "UP" : "DOWN"}
            </strong>{" "}
            @ ${selectedStrike.toLocaleString()}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
            DeepEdge fair value: {fairPct}% &middot; this will sign an on-chain
            transaction
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleBet} style={primaryBtn}>
              Confirm
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              style={{
                padding: "8px 20px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "white",
                color: "var(--text-muted)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status.kind !== "idle" && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 10,
            fontSize: 13,
            background: status.kind === "error" ? "#fef2f2" : status.kind === "ok" ? "#f0fdf4" : "#f0f9ff",
            color: status.kind === "error" ? "var(--down)" : status.kind === "ok" ? "#15803d" : "var(--primary-dark)",
          }}
        >
          {status.kind === "working" && status.msg}
          {status.kind === "error" && `x ${status.msg}`}
          {status.kind === "ok" && (
            <>
              {status.msg}
              {status.digest && (
                <a
                  href={`https://testnet.suivision.xyz/txblock/${status.digest}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "block", marginTop: 4, color: "var(--primary)", fontSize: 12 }}
                >
                  View transaction
                </a>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="card" style={{ padding: 24 }}>{children}</div>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--text-muted)", margin: 0 }}>{children}</p>;
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  fontSize: 14,
  color: "var(--text)",
};
const primaryBtn: React.CSSProperties = {
  padding: "8px 20px",
  borderRadius: 10,
  border: "none",
  background: "var(--primary)",
  color: "white",
  fontWeight: 700,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  padding: "8px 20px",
  borderRadius: 10,
  border: "1px solid var(--primary)",
  background: "white",
  color: "var(--primary)",
  fontWeight: 600,
  cursor: "pointer",
};
const upBtn: React.CSSProperties = {
  flex: 1,
  padding: "10px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "white",
  color: "var(--up)",
  fontWeight: 700,
  cursor: "pointer",
};
const upBtnActive: React.CSSProperties = { ...upBtn, background: "var(--up)", color: "white", border: "none" };
const downBtn: React.CSSProperties = { ...upBtn, color: "var(--down)" };
const downBtnActive: React.CSSProperties = { ...downBtn, background: "var(--down)", color: "white", border: "none" };
const rangeBtn: React.CSSProperties = { ...upBtn, color: "var(--primary-dark)" };
const rangeBtnActive: React.CSSProperties = {
  ...rangeBtn,
  background: "var(--primary-dark)",
  color: "white",
  border: "none",
};
