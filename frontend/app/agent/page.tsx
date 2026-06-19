"use client";

import { useEffect, useState } from "react";
import { api, AgentResult, AgentStep, MandateStatus } from "@/lib/api";

const STAGE_META: Record<string, { icon: string; label: string }> = {
  observe: { icon: "1", label: "Observe market" },
  position_review: { icon: "↺", label: "Review open positions" },
  strategist: { icon: "2", label: "Strategist proposes" },
  risk_officer: { icon: "3", label: "Risk Officer reviews" },
  walrus: { icon: "4", label: "Store on Walrus" },
  verify: { icon: "5", label: "Verify hash" },
  enforce: { icon: "6", label: "Enforce + record on-chain" },
};

function fmtDusdc(micro: number): string {
  return (micro / 1_000_000).toFixed(2);
}

function hoursUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms) || ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export default function AgentPage() {
  const [running, setRunning] = useState(false);
  const [popping, setPopping] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mandate, setMandate] = useState<MandateStatus | null>(null);

  const loadStatus = () => {
    api.agentStatus().then(setMandate).catch(() => {});
  };
  useEffect(() => { loadStatus(); }, []);

  const runCycle = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const res = await api.agentRun();
      setResult(res);
      loadStatus();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "run failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: "var(--text)" }}>
          Autonomous AI Agent
        </h1>
        <p style={{ color: "var(--text-muted)", marginTop: 8, maxWidth: 680 }}>
          Two AI agents work as a team on a real market. One proposes a
          bet; the other checks whether it would actually win, using the
          market&apos;s own track record. The AI can only spend up to a fixed
          on-chain limit &mdash; it simply cannot go over. Every decision is
          saved and stamped on-chain, so anyone can verify it for themselves.
        </p>
      </div>

      {mandate && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 20, background: "#ffffff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontWeight: 600, color: "var(--text)" }}>Mandate (on-chain enforcement)</span>
            <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, background: mandate.active ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color: mandate.active ? "#16a34a" : "#dc2626" }}>
              {mandate.active ? "ACTIVE" : "KILLED"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 14, color: "var(--text-muted)" }}>
            <div>Per-bet cap: <b style={{ color: "var(--text)" }}>{fmtDusdc(Number(mandate.per_bet_cap))} DUSDC</b></div>
            <div>Spent: <b style={{ color: "var(--text)" }}>{fmtDusdc(Number(mandate.spent))} / {fmtDusdc(Number(mandate.total_budget))} DUSDC</b></div>
          </div>
          <div style={{ marginTop: 12, height: 8, background: "var(--border)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, (Number(mandate.spent) / Number(mandate.total_budget)) * 100)}%`, background: "#0284c7" }} />
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, marginBottom: 0 }}>
            Mathematically proven (Sui Prover): the AI can never bet more than this cap &mdash; in any situation. Guaranteed by a formal proof, not just testing.
          </p>
        </div>
      )}

      <div style={{ position: "relative", display: "inline-block", alignSelf: "flex-start" }}>
        <button
          disabled={running}
          aria-hidden="true"
          tabIndex={-1}
          style={{
            padding: "12px 28px", fontSize: 16, fontWeight: 600,
            borderRadius: 10, border: "none", cursor: "default",
            background: running ? "var(--border)" : "#0284c7",
            color: running ? "var(--text-muted)" : "#fff",
            pointerEvents: "none",
          }}
        >
          {running ? "Running cycle… (20-40s)" : "Run one cycle"}
        </button>
        <span
          onClick={() => { if (!running) runCycle(); }}
          onMouseEnter={() => {
            setPopping(true);
            setTimeout(() => setPopping(false), 260);
          }}
          title="Run one cycle"
          style={{
            position: "absolute",
            top: -12,
            right: -14,
            fontSize: 26,
            lineHeight: 1,
            color: "#ff4da6",
            cursor: running ? "default" : "pointer",
            userSelect: "none",
            transform: "rotate(18deg)",
            animation: popping ? "heartWiggle 0.4s ease-in-out" : "none",
            textShadow: "0 1px 2px rgba(0,0,0,0.15)",
            opacity: running ? 0.4 : 1,
          }}
        >
          ♥
        </span>
      </div>

      {err && <div style={{ color: "#dc2626", fontSize: 14 }}>Error: {err}</div>}

      {result && result.steps && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {result.steps.map((s: AgentStep, i: number) => (
            <StepCard key={i} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepCard({ step }: { step: AgentStep }) {
  const meta = STAGE_META[step.stage] || { icon: "•", label: step.stage };
  const outcome = step.outcome;  // "bet" | "veto" | "no_bet" | "error"
  const isReview = step.stage === "risk_officer";
  const approved = isReview && step.review?.approved;
  let accent = "var(--border)";
  if (step.stage === "risk_officer") accent = approved ? "#16a34a" : "#dc2626";
  if (step.stage === "enforce") {
    accent = outcome === "bet" ? "#16a34a" : outcome === "veto" ? "#dc2626" : "#64748b";
  }
  if (step.stage === "verify") accent = step.match ? "#16a34a" : "#dc2626";

  return (
    <div style={{ border: "1px solid var(--border)", borderLeft: `3px solid ${accent}`, borderRadius: 10, padding: 16, background: "#ffffff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ width: 24, height: 24, borderRadius: 999, background: "var(--border)", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700 }}>{meta.icon}</span>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{meta.label}</span>
      </div>
      <div style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {step.market && (
          <div>{step.market.asset} @ ${step.market.strike_usd.toLocaleString()} · exp {step.market.expiry.slice(0,10)} ({hoursUntil(step.market.expiry)}) · fair P(up) {step.fair ? step.fair.up.toFixed(4) : ""}</div>
        )}
        {step.proposal && (
          <div><b style={{ color: "var(--text)" }}>{step.proposal.action}</b> size {fmtDusdc(step.proposal.size)} DUSDC — {step.proposal.thesis}</div>
        )}
        {step.stage === "position_review" && (
          (step.open_count ?? 0) === 0 ? (
            <div>No open positions — nothing to manage yet.</div>
          ) : (
            <div>
              <div style={{ marginBottom: 6 }}>
                Reviewing <b style={{ color: "var(--text)" }}>{step.open_count}</b> open position
                {step.open_count === 1 ? "" : "s"} for take-profit / stop-loss
                {(step.redeem_suggested ?? 0) > 0 && (
                  <> — <b style={{ color: "#dc2626" }}>{step.redeem_suggested} flagged to redeem</b></>
                )}
                .
              </div>
              {(step.holdings_review ?? []).map((h, j) => (
                <div key={j} style={{ marginTop: 2 }}>
                  <b style={{ color: "var(--text)" }}>{h.side} ${h.strike_usd.toLocaleString()}</b>{" "}
                  <span
                    style={{
                      color: h.action === "redeem" ? "#dc2626" : "#16a34a",
                      fontWeight: 700,
                    }}
                  >
                    {h.action === "redeem" ? "REDEEM" : "HOLD"}
                  </span>{" "}
                  — {h.reason}
                </div>
              ))}
            </div>
          )
        )}
        {step.review && (
          <div>
            <b style={{ color: approved ? "#16a34a" : "#dc2626" }}>{approved ? "APPROVED" : "VETO"}</b>
            {" "}(calibration-adjusted P(up) {step.review.calibration_adjusted_prob}) — {step.review.verdict}
          </div>
        )}
        {step.blob_id && (
          <div>Walrus blob: <code style={{ fontSize: 12 }}>{step.blob_id}</code><br/>sha256: <code style={{ fontSize: 12 }}>{step.sha256}</code></div>
        )}
        {step.stage === "verify" && (
          <div>{step.match ? "✓ blob re-hashes to the on-chain value" : "✗ hash mismatch"}</div>
        )}
        {step.stage === "enforce" && outcome === "bet" && step.digest && (
          <div>Recorded on-chain · spent {fmtDusdc(step.spent_amount || 0)} DUSDC<br/>digest: <code style={{ fontSize: 12 }}>{step.digest}</code></div>
        )}
        {step.stage === "enforce" && outcome === "veto" && (
          <div>No on-chain spend — the Risk Officer <b style={{ color: "#dc2626" }}>vetoed</b> the proposal. Reasoning still stored on Walrus.</div>
        )}
        {step.stage === "enforce" && outcome === "no_bet" && (
          <div>No on-chain spend — both agents agreed there is <b>no edge</b> to bet on. Reasoning still stored on Walrus.</div>
        )}
        {step.stage === "enforce" && outcome === "error" && (
          <div style={{ color: "#dc2626" }}>Enforcement error: {step.error}</div>
        )}
      </div>
    </div>
  );
}
