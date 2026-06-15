"use client";

import { useEffect, useState } from "react";
import { api, DensityResponse, MarketSummary } from "@/lib/api";

function usd(n: number): string {
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function DensityPage() {
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<DensityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the market list, pick the one nearest ~30 days as a sensible default.
  useEffect(() => {
    api.markets()
      .then((r) => {
        const active = r.markets.filter((m) => m.status === "active");
        setMarkets(active);
        if (active.length) {
          const now = Date.now();
          const target = 30 * 24 * 3600 * 1000;
          const best = active.reduce((b, m) =>
            Math.abs(m.expiry - now - target) < Math.abs(b.expiry - now - target) ? m : b
          , active[0]);
          setSelected(best.oracle_id);
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setData(null);
    api.density(selected).then(setData).catch((e) => setError(e.message));
  }, [selected]);

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: "var(--text)" }}>
        Risk-Neutral Density
      </h1>
      <p style={{ color: "var(--muted)", marginTop: 8, lineHeight: 1.6, maxWidth: 640 }}>
        The probability distribution the SVI surface implies for where BTC settles, via
        Breeden-Litzenberger. It reuses the same butterfly function g(k) as the arbitrage
        check — so an arbitrage-free surface is exactly one whose density is non-negative.
        The agent&apos;s two reviewers read this density before any bet, cross-checking its
        P(up) against the model&apos;s fair value.
      </p>

      {markets.length > 0 && (
        <select
          value={selected || ""}
          onChange={(e) => setSelected(e.target.value)}
          style={{
            marginTop: 16, padding: "8px 12px", fontSize: 14, borderRadius: 8,
            border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)",
          }}
        >
          {markets.map((m) => {
            const days = Math.round((m.expiry - Date.now()) / 86400000);
            return (
              <option key={m.oracle_id} value={m.oracle_id}>
                {m.underlying_asset} · {days}d to expiry · {m.oracle_id.slice(0, 12)}…
              </option>
            );
          })}
        </select>
      )}

      {error && (
        <div style={{ marginTop: 24, padding: 16, borderRadius: 8, background: "#fee2e2", color: "#dc2626" }}>
          Couldn&apos;t load the density: {error}.
        </div>
      )}

      {selected && !data && !error && (
        <p style={{ marginTop: 24, color: "var(--muted)" }}>Computing the density…</p>
      )}

      {data && data.grid && (() => {
        const g = data.grid!;
        return (
          <>
            {/* Summary: the three things you read off a density */}
            <div style={{
              marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1,
              background: "var(--border)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden",
            }}>
              <Stat label="Most-likely settlement" value={usd(g.mode_usd)} sub="mode of the distribution" />
              <Stat label="P(up)" value={g.prob_up.toFixed(3)} sub="P(settle > forward)" />
              <Stat label="90% range" value={`${usd(g.p05_usd)} – ${usd(g.p95_usd)}`} sub="5th to 95th percentile" />
            </div>

            {/* The density curve */}
            <div style={{ marginTop: 24, padding: 20, borderRadius: 10, border: "1px solid var(--border)" }}>
              <DensityCurve grid={g} />
            </div>

            <p style={{ marginTop: 20, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
              Computed in Rust from the oracle&apos;s live SVI parameters, normalized numerically.
              Tenor: {(g.seconds_until_expiry / 86400).toFixed(0)} days. This is the same density the
              Strategist and Risk Officer weigh against the model&apos;s fair value — analytics that
              feed an accountable, auditable decision, not just a chart.
            </p>
          </>
        );
      })()}

      {data && !data.grid && (
        <p style={{ marginTop: 24, color: "var(--muted)" }}>
          No SVI data for this market yet — pick another expiry.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: "var(--bg)", padding: "16px 18px" }}>
      <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{sub}</div>
    </div>
  );
}

function DensityCurve({ grid }: { grid: { points: { strike_usd: number; density: number }[]; forward_usd: number; mode_usd: number; p05_usd: number; p95_usd: number } }) {
  const W = 800, H = 280, padL = 8, padR = 8, padT = 16, padB = 36;
  const pts = grid.points.filter((p) => p.density >= 0);
  if (pts.length < 2) return <div style={{ color: "var(--muted)" }}>Not enough points to plot.</div>;

  const xs = pts.map((p) => p.strike_usd);
  const ds = pts.map((p) => p.density);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const dMax = Math.max(...ds);

  const sx = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * (W - padL - padR);
  const sy = (d: number) => H - padB - (d / dMax) * (H - padT - padB);

  // Area path under the curve.
  let area = `M ${sx(xs[0])} ${H - padB}`;
  pts.forEach((p) => { area += ` L ${sx(p.strike_usd)} ${sy(p.density)}`; });
  area += ` L ${sx(xs[xs.length - 1])} ${H - padB} Z`;

  // Line path.
  let line = `M ${sx(pts[0].strike_usd)} ${sy(pts[0].density)}`;
  pts.forEach((p) => { line += ` L ${sx(p.strike_usd)} ${sy(p.density)}`; });

  const fwdX = sx(grid.forward_usd);
  const modeX = sx(grid.mode_usd);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {/* 90% band shading */}
      <rect x={sx(grid.p05_usd)} y={padT} width={Math.max(0, sx(grid.p95_usd) - sx(grid.p05_usd))} height={H - padT - padB}
            fill="var(--primary)" opacity="0.06" />
      {/* area + line */}
      <path d={area} fill="var(--primary)" opacity="0.14" />
      <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2" />
      {/* forward marker */}
      <line x1={fwdX} y1={padT} x2={fwdX} y2={H - padB} stroke="var(--muted)" strokeWidth="1" strokeDasharray="4 3" />
      <text x={fwdX} y={H - padB + 14} fontSize="11" fill="var(--muted)" textAnchor="middle">forward {usd(grid.forward_usd)}</text>
      {/* mode marker */}
      <line x1={modeX} y1={padT} x2={modeX} y2={H - padB} stroke="#16a34a" strokeWidth="1" strokeDasharray="2 2" />
      <text x={modeX} y={padT + 4} fontSize="11" fill="#16a34a" textAnchor="middle">mode</text>
    </svg>
  );
}
