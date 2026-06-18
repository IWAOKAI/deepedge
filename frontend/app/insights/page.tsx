"use client";

import { useEffect, useState } from "react";
import { api, CalibrationReport, CalibrationBucket } from "@/lib/api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

export default function InsightsPage() {
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .calibration()
      .then(setReport)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
        Running calibration backtest…
      </div>
    );
  if (error || !report)
    return (
      <div className="card" style={{ padding: 24, color: "var(--down)" }}>
        Could not load calibration: {error}
      </div>
    );

  // 統計的に厚いバケット（n>=40）だけをチャートに
  const reliable = report.buckets.filter((b) => b.bet_count >= 40);

  const chartData = reliable.map((b) => ({
    range: `${Math.round(b.bucket_low * 100)}-${Math.round(b.bucket_high * 100)}%`,
    implied: +(b.avg_implied_prob * 100).toFixed(1),
    actual: +(b.actual_win_rate * 100).toFixed(1),
    n: b.bet_count,
  }));

  return (
    <div>
      <h1
        style={{
          fontSize: 30,
          fontWeight: 800,
          margin: "0 0 6px",
          color: "var(--primary-dark)",
          letterSpacing: "-0.02em",
        }}
      >
        Market Calibration
      </h1>
      <p style={{ color: "var(--text-muted)", margin: "0 0 24px", fontSize: 15 }}>
        Did the market&apos;s implied probability match what actually happened?
        Backtested on {report.total_bets_evaluated} settled bets.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
          marginBottom: 28,
        }}
      >
        <Stat
          label="Bets analyzed"
          value={report.total_bets_evaluated.toString()}
        />
        <Stat
          label="Blind-buy ROI"
          value={`${(report.overall_avg_roi * 100).toFixed(0)}%`}
          tone="down"
          hint="buying at market ask"
        />
        <Stat
          label="Avg calibration error"
          value={`${(report.mean_abs_calibration_error * 100).toFixed(1)}%`}
        />
      </div>

      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>
          Implied vs. Actual win rate
        </h2>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-muted)",
            margin: "0 0 18px",
          }}
        >
          Reliable buckets only (n ≥ 40). Where bars diverge, the market was
          mispriced.
        </p>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0f2fe" />
            <XAxis dataKey="range" tick={{ fontSize: 12, fill: "#64748b" }} />
            <YAxis
              tick={{ fontSize: 12, fill: "#64748b" }}
              label={{
                value: "%",
                angle: 0,
                position: "insideLeft",
                fill: "#64748b",
              }}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 12,
                border: "1px solid var(--border)",
                fontSize: 13,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 13 }} />
            <Bar
              dataKey="implied"
              name="Market implied"
              fill="#0ea5e9"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="actual"
              name="Actual outcome"
              fill="#10b981"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 14px" }}>
          The headline finding
        </h2>
        <UpBiasCallout buckets={report.buckets} />
      </div>

      <DirectionTable buckets={reliable} />
    </div>
  );
}

function UpBiasCallout({ buckets }: { buckets: CalibrationBucket[] }) {
  const b = buckets.find((x) => x.bucket_low === 0.4);
  if (!b) return null;
  return (
    <div style={{ fontSize: 15, lineHeight: 1.6 }}>
      In the <strong>40–50%</strong> band, traders placed{" "}
      <strong>{b.up_count}</strong> UP bets vs{" "}
      <strong>{b.down_count}</strong> DOWN bets. Those near-even-money UP bets
      were priced at{" "}
      <strong style={{ color: "var(--primary-dark)" }}>
        {(b.up_implied * 100).toFixed(0)}%
      </strong>{" "}
      but settled in the money{" "}
      <strong style={{ color: "var(--up)" }}>
        {(b.up_actual * 100).toFixed(0)}%
      </strong>{" "}
      of the time — the market underpriced this band by{" "}
      <strong style={{ color: "var(--up)" }}>
        {((b.up_actual - b.up_implied) * 100).toFixed(0)}
      </strong>{" "}
      points. DeepEdge measures this gap on every settled bet, so you can see
      where the market&apos;s price and the real outcome have drifted apart.
    </div>
  );
}

function DirectionTable({ buckets }: { buckets: CalibrationBucket[] }) {
  return (
    <div className="card" style={{ padding: 24, overflowX: "auto" }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 14px" }}>
        UP vs DOWN breakdown (reliable buckets)
      </h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "8px 6px" }}>Range</th>
            <th style={{ padding: "8px 6px" }}>UP n</th>
            <th style={{ padding: "8px 6px" }}>UP implied</th>
            <th style={{ padding: "8px 6px" }}>UP actual</th>
            <th style={{ padding: "8px 6px" }}>DOWN n</th>
            <th style={{ padding: "8px 6px" }}>DOWN implied</th>
            <th style={{ padding: "8px 6px" }}>DOWN actual</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.bucket_low} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 6px", fontWeight: 600 }}>
                {Math.round(b.bucket_low * 100)}-{Math.round(b.bucket_high * 100)}%
              </td>
              <td style={{ padding: "8px 6px" }}>{b.up_count}</td>
              <td style={{ padding: "8px 6px" }}>
                {(b.up_implied * 100).toFixed(1)}%
              </td>
              <td style={{ padding: "8px 6px", fontWeight: 600 }}>
                {(b.up_actual * 100).toFixed(1)}%
              </td>
              <td style={{ padding: "8px 6px" }}>{b.down_count}</td>
              <td style={{ padding: "8px 6px" }}>
                {(b.down_implied * 100).toFixed(1)}%
              </td>
              <td style={{ padding: "8px 6px", fontWeight: 600 }}>
                {(b.down_actual * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "down";
  hint?: string;
}) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 800,
          marginTop: 4,
          color: tone === "down" ? "var(--down)" : "var(--primary-dark)",
        }}
      >
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
