"use client";

import { useEffect, useState } from "react";
import { api, CrossVenueResponse } from "@/lib/api";

const RICHNESS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  rich: { color: "#dc2626", bg: "#fee2e2", label: "RICH — Predict IV above Deribit" },
  cheap: { color: "#16a34a", bg: "#dcfce7", label: "CHEAP — Predict IV below Deribit" },
  "in line": { color: "#475569", bg: "#e2e8f0", label: "IN LINE — close to Deribit" },
};

function pct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

export default function CrossVenuePage() {
  const [data, setData] = useState<CrossVenueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.crossVenue().then(setData).catch((e) => setError(e.message));
  }, []);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: "var(--text)" }}>Cross-Venue</h1>
      <p style={{ color: "var(--muted)", marginTop: 8, lineHeight: 1.6, maxWidth: 640 }}>
        On-chain implied vol means little in isolation. This frames Predict&apos;s ATM IV against
        Deribit&apos;s DVOL index and Binance&apos;s realized vol — telling you whether Predict is rich
        or cheap, and whether selling vol carries an edge. If Predict drifts far from the rest of
        the market, the Risk Officer treats the on-chain surface as suspect.
      </p>

      {error && (
        <div style={{ marginTop: 24, padding: 16, borderRadius: 8, background: "#fee2e2", color: "#dc2626" }}>
          Couldn&apos;t load the cross-venue read: {error}.
        </div>
      )}

      {!data && !error && (
        <p style={{ marginTop: 24, color: "var(--muted)" }}>Reading Deribit and Binance…</p>
      )}

      {data && (() => {
        const richness = data.predict_richness || "in line";
        const rs = RICHNESS_STYLE[richness] || RICHNESS_STYLE["in line"];
        return (
          <>
            {/* The three vols side by side */}
            <div style={{
              marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1,
              background: "var(--border)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden",
            }}>
              <Vol label="Predict ATM IV" value={pct(data.predict_atm_iv)}
                   sub={data.predict_tenor_days ? `on-chain · ${data.predict_tenor_days.toFixed(0)}d tenor` : "on-chain"} />
              <Vol label="Deribit DVOL" value={pct(data.deribit_dvol)} sub="BTC vol index" />
              <Vol label="Binance realized" value={pct(data.binance_realized_vol)}
                   sub={`${data.realized_window_days}d, annualized`} />
            </div>

            {/* Richness verdict */}
            <div style={{
              marginTop: 24, padding: "24px", borderRadius: 12, background: rs.bg,
              border: `2px solid ${rs.color}`, textAlign: "center",
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: rs.color, letterSpacing: 1, textTransform: "uppercase" }}>
                Predict vs Deribit
              </div>
              <div style={{ fontSize: 36, fontWeight: 800, color: rs.color, marginTop: 6 }}>
                {data.predict_vs_deribit === null ? "—" : `${data.predict_vs_deribit > 0 ? "+" : ""}${data.predict_vs_deribit.toFixed(1)}%`}
              </div>
              <div style={{ fontSize: 14, color: rs.color, marginTop: 4 }}>{rs.label}</div>
            </div>

            {/* Vol-risk-premium */}
            <div style={{ marginTop: 24, padding: 20, borderRadius: 10, border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Volatility risk premium</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: (data.vol_risk_premium ?? 0) >= 0 ? "#16a34a" : "#b45309" }}>
                  {data.vol_risk_premium === null ? "—" : `${data.vol_risk_premium > 0 ? "+" : ""}${data.vol_risk_premium.toFixed(1)}%`}
                </div>
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8, lineHeight: 1.6 }}>
                Deribit implied minus Binance realized. Positive means implied vol sits above what the
                market actually delivered — the spread an LP earns for selling vol. Negative means
                realized has run hot, and selling vol has been a losing trade lately.
              </div>
            </div>

            {data.btc_index_price && (
              <p style={{ marginTop: 20, fontSize: 13, color: "var(--muted)" }}>
                BTC index (Deribit): ${data.btc_index_price.toLocaleString(undefined, { maximumFractionDigits: 0 })}.
                References pulled live from Deribit and Binance; the Predict figure is the on-chain ATM IV at
                the tenor closest to the 30-day reference, so the comparison is implied-vs-implied.
              </p>
            )}
          </>
        );
      })()}
    </div>
  );
}

function Vol({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: "var(--bg)", padding: "16px 18px" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{sub}</div>
    </div>
  );
}
