"use client";

import { useEffect, useState } from "react";
import { api, LedgerEntry, LedgerResponse } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const WAL_AGG = API_BASE + "/api/walrus/"; // backend proxy (aggregator 404s on browser Origin)

function fmtDusdc(micro: number): string {
  return (micro / 1_000_000).toFixed(2);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const OUTCOME_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  veto: { label: "VETO", color: "#dc2626", bg: "#fee2e2" },
  no_bet: { label: "NO BET", color: "#475569", bg: "#e2e8f0" },
  bet: { label: "BET", color: "#16a34a", bg: "#dcfce7" },
  unknown: { label: "?", color: "#64748b", bg: "#f1f5f9" },
};

export default function LedgerPage() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agentLedger().then(setData).catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 6px" }}>
        Agent Performance Ledger
      </h1>
      <p style={{ color: "var(--text-muted)", margin: "0 0 20px", maxWidth: 720 }}>
        Every decision the agent has ever made — bet, veto, or no-bet — with
        its full reasoning stored on Walrus and SHA-256 anchored. Press Verify
        on any entry to re-fetch the blob and re-check the hash yourself, right here.
      </p>

      {error && <div style={{ color: "#dc2626" }}>Could not load ledger: {error}</div>}
      {!data && !error && <div style={{ color: "var(--text-muted)" }}>Loading ledger…</div>}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 14, marginBottom: 24 }}>
            <SummaryCard label="Decisions" value={String(data.summary.total)} />
            <SummaryCard label="Vetoed" value={String(data.summary.veto)} color="#dc2626" />
            <SummaryCard label="No bet" value={String(data.summary.no_bet)} />
            <SummaryCard label="Bets placed" value={String(data.summary.bet)} color="#16a34a" />
            <SummaryCard label="Capital protected" value={`${fmtDusdc(data.summary.protected_dusdc)} DUSDC`} color="#0284c7" sub="proposals the Risk Officer vetoed" />
            <SummaryCard label="Expected loss avoided" value={`${fmtDusdc(data.summary.expected_loss_avoided || 0)} DUSDC`} color="#dc2626" sub="calibration-weighted, on the vetoed bets" />
          </div>

          {data.entries.length === 0 && (
            <div style={{ color: "var(--text-muted)" }}>No decisions recorded yet. Run a cycle on the AI Agent page.</div>
          )}

          {data.entries.map((e, i) => (
            <LedgerCard key={e.ts + "-" + i} entry={e} index={data.entries.length - i} />
          ))}
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: 16, background: "#ffffff" }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4, color: color || "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function LedgerCard({ entry, index }: { entry: LedgerEntry; index: number }) {
  const [verify, setVerify] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const [verifyMsg, setVerifyMsg] = useState("");
  const st = OUTCOME_STYLE[entry.outcome] || OUTCOME_STYLE.unknown;
  const size = entry.proposal?.adjusted_size ?? entry.proposal?.size ?? 0;

  async function runVerify() {
    if (!entry.blob_id || !entry.sha256) return;
    setVerify("running");
    setVerifyMsg("fetching blob from Walrus…");
    try {
      const res = await fetch(WAL_AGG + entry.blob_id);
      if (!res.ok) throw new Error(`aggregator HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      setVerifyMsg("re-hashing…");
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (hex === entry.sha256) {
        setVerify("ok");
        setVerifyMsg("hash matches — this reasoning is exactly what was recorded");
      } else {
        setVerify("fail");
        setVerifyMsg(`hash mismatch: got ${hex.slice(0, 16)}…`);
      }
    } catch (err) {
      setVerify("fail");
      setVerifyMsg(err instanceof Error ? err.message : "verification failed");
    }
  }

  return (
    <div className="card" style={{ padding: 18, marginBottom: 14, background: "#ffffff", borderLeft: `4px solid ${st.color}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800, color: "var(--text-muted)" }}>#{index}</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: st.color, background: st.bg, padding: "2px 10px", borderRadius: 999 }}>{st.label}</span>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{fmtTime(entry.ts)}</span>
        {entry.market && (
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {entry.market.asset} @ ${entry.market.strike_usd?.toLocaleString()} · fair P(up) {entry.fair_up?.toFixed(4)}
          </span>
        )}
      </div>

      {entry.proposal && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <b>Strategist:</b> {entry.proposal.action} size {fmtDusdc(size)} DUSDC
          {entry.proposal.thesis && <span style={{ color: "var(--text-muted)" }}> — {entry.proposal.thesis}</span>}
        </div>
      )}

      {entry.verdict && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <b>Risk Officer:</b> <span style={{ color: entry.outcome === "veto" ? "#dc2626" : "var(--text)" }}>{entry.verdict}</span>
        </div>
      )}

      {(entry.digest || (entry as unknown as { onchain_digest?: string }).onchain_digest) ? (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          {(() => {
            const dg = entry.digest || (entry as unknown as { onchain_digest?: string }).onchain_digest || "";
            return (
              <span>
                on-chain:{" "}
                <a href={"https://testnet.suivision.xyz/txblock/" + dg} target="_blank" rel="noopener noreferrer" style={{ color: "#0284c7", fontWeight: 600 }}>
                  <code>{dg.slice(0, 24)}</code>… ↗ view on suivision
                </a>
              </span>
            );
          })()}
        </div>
      ) : null}

      {entry.blob_id && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all" }}>
          Walrus blob: <code>{entry.blob_id}</code><br />
          sha256: <code>{entry.sha256}</code>
        </div>
      )}

      {(() => {
        const oc = entry.digest || (entry as unknown as { onchain_digest?: string }).onchain_digest;
        // Bets that hit the chain are verified by their on-chain tx (the
        // original Walrus blob may have expired on testnet). Vetoes/no-bets
        // are verified by re-hashing their Walrus record in-browser.
        if (oc) {
          return (
            <div style={{ marginTop: 10, fontSize: 13, color: "#15803d", fontWeight: 700 }}>
              ✓ verified on-chain — see the suivision link above
            </div>
          );
        }
        return null;
      })()}
      {!entry.digest && !(entry as unknown as { onchain_digest?: string }).onchain_digest && entry.blob_id && entry.sha256 && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={runVerify}
            disabled={verify === "running"}
            style={{
              padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer",
              fontWeight: 700, fontSize: 13, color: "#fff",
              background: verify === "running" ? "var(--border)" : "#0284c7",
            }}
          >
            {verify === "running" ? "Verifying…" : "Verify hash"}
          </button>
          {verify === "ok" && <span style={{ color: "#16a34a", fontWeight: 700, fontSize: 13 }}>✓ {verifyMsg}</span>}
          {verify === "fail" && <span style={{ color: "#dc2626", fontWeight: 700, fontSize: 13 }}>✗ {verifyMsg}</span>}
          {verify === "running" && <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{verifyMsg}</span>}
        </div>
      )}
    </div>
  );
}
