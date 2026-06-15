"use client";

import { useEffect, useState } from "react";
import { api, VaultHealthResponse } from "@/lib/api";

const GRADE_STYLE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  GREEN: { color: "#16a34a", bg: "#dcfce7", border: "#16a34a", label: "GREEN — safe to back" },
  AMBER: { color: "#b45309", bg: "#fef3c7", border: "#d97706", label: "AMBER — caution" },
  RED: { color: "#dc2626", bg: "#fee2e2", border: "#dc2626", label: "RED — breach risk" },
};

function usd(n: number): string {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function VaultPage() {
  const [data, setData] = useState<VaultHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.vaultHealth().then(setData).catch((e) => setError(e.message));
  }, []);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: "var(--text)" }}>Vault</h1>
      <p style={{ color: "var(--muted)", marginTop: 8, lineHeight: 1.6, maxWidth: 620 }}>
        Every bet on this market is backed by a shared vault — if it can&apos;t pay out, the
        market breaks. This is the one number that matters: is the vault healthy? It checks
        whether the vault can cover its worst-case payout, how much is already at risk, and
        whether funds can be withdrawn. The AI&apos;s Risk Officer reads this same grade before
        sizing any bet — a stressed vault means it bets smaller, or not at all.
      </p>

      {error && (
        <div style={{ marginTop: 24, padding: 16, borderRadius: 8, background: "#fee2e2", color: "#dc2626" }}>
          Couldn&apos;t load the vault right now: {error}. The on-chain data path may be briefly unavailable — try again shortly.
        </div>
      )}

      {!data && !error && (
        <p style={{ marginTop: 24, color: "var(--muted)" }}>Reading the vault from chain…</p>
      )}

      {data && (() => {
        const h = data.health;
        const gs = GRADE_STYLE[h.grade] || GRADE_STYLE.AMBER;
        return (
          <>
            {/* Grade badge — the one answer, led with */}
            <div style={{
              marginTop: 28, padding: "28px 24px", borderRadius: 12,
              background: gs.bg, border: `2px solid ${gs.border}`,
              textAlign: "center",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: gs.color, letterSpacing: 1, textTransform: "uppercase" }}>
                Vault solvency
              </div>
              <div style={{ fontSize: 44, fontWeight: 800, color: gs.color, marginTop: 6 }}>
                {h.grade}
              </div>
              <div style={{ fontSize: 14, color: gs.color, marginTop: 4 }}>{gs.label}</div>
            </div>

            {/* The numbers that justify the grade */}
            <div style={{
              marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1,
              background: "var(--border)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden",
            }}>
              <Metric label="Vault value" value={usd(h.vault_value_usd)} sub="total assets backing the book" />
              <Metric label="Worst-case payout" value={usd(h.max_payout_usd)} sub="maximum the vault could owe" />
              <Metric label="Breach headroom" value={`${h.breach_headroom_pct.toFixed(1)}%`}
                      sub="vault value left after worst case"
                      good={h.breach_headroom_pct > 20} />
              <Metric label="Max-payout utilization" value={`${(h.max_payout_utilization * 100).toFixed(0)}%`}
                      sub="share of vault committed"
                      good={h.max_payout_utilization < 0.7} />
              <Metric label="Exit liquidity" value={`${h.withdrawal_headroom_pct.toFixed(1)}%`}
                      sub="of vault value withdrawable now"
                      good={h.withdrawal_headroom_pct > 5} />
              <Metric label="Open book (MTM)" value={usd(h.total_mtm_usd)} sub="mark-to-market of positions" />
            </div>

            {/* Why this grade */}
            <div style={{ marginTop: 24, padding: 20, borderRadius: 10, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>
                Why this grade
              </div>
              {h.reasons.map((r, i) => (
                <div key={i} style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.6, marginBottom: 4 }}>
                  • {r}
                </div>
              ))}
            </div>

            <p style={{ marginTop: 20, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
              Every figure is computed from the vault&apos;s live on-chain reserves and exposure —
              nothing sampled or mocked. When the grade says the vault is stressed, the Risk
              Officer is told to cut size or veto, even when an edge looks acceptable.
            </p>
          </>
        );
      })()}
    </div>
  );
}

function Metric({ label, value, sub, good }: { label: string; value: string; sub: string; good?: boolean }) {
  return (
    <div style={{ background: "var(--bg)", padding: "16px 18px" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 700, marginTop: 4,
        color: good === undefined ? "var(--text)" : good ? "#16a34a" : "#b45309",
      }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{sub}</div>
    </div>
  );
}
