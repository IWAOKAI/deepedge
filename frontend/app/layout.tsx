import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { ClientProviders } from "./client-providers";

export const metadata: Metadata = {
  title: "DeepEdge — See the Math",
  description:
    "Quant analytics layer for DeepBook Predict. Don't bet blind. See the math.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ClientProviders>
        <header
          style={{
            borderBottom: "1px solid var(--border)",
            background: "rgba(255,255,255,0.7)",
            backdropFilter: "blur(8px)",
            position: "sticky",
            top: 0,
            zIndex: 10,
          }}
        >
          <div
            style={{
              maxWidth: 1100,
              margin: "0 auto",
              padding: "16px 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Link
              href="/"
              style={{
                fontWeight: 800,
                fontSize: 20,
                color: "var(--primary-dark)",
                textDecoration: "none",
                letterSpacing: "-0.02em",
              }}
            >
              Deep<span style={{ color: "var(--primary)" }}>Edge</span>
            </Link>
            <nav style={{ display: "flex", gap: 24, fontSize: 14, fontWeight: 600, alignItems: "center" }}>
              <Link href="/" style={{ color: "var(--text)", textDecoration: "none" }}>
                Markets
              </Link>
              <Link
                href="/overview"
                style={{ color: "var(--text)", textDecoration: "none" }}
              >
                Overview
              </Link>
              <Link
                href="/insights"
                style={{ color: "var(--text)", textDecoration: "none" }}
              >
                Insights
              </Link>
              <Link
                href="/portfolio"
                style={{ color: "var(--text)", textDecoration: "none" }}
              >
                Portfolio
              </Link>
              <Link
                href="/agent"
                style={{ color: "var(--text)", textDecoration: "none" }}
              >
                AI Agent
              </Link>
          <Link href="/ledger">Ledger</Link>
              <Link href="/vault" style={{ color: "var(--text)", textDecoration: "none" }}>
                Vault
              </Link>
              <Link href="/density" style={{ color: "var(--text)", textDecoration: "none" }}>
                Density
              </Link>
              <Link href="/cross-venue" style={{ color: "var(--text)", textDecoration: "none" }}>
                Cross-Venue
              </Link>
            </nav>
          </div>
        </header>
        <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
          {children}
        </main>
        </ClientProviders>
      </body>
    </html>
  );
}
