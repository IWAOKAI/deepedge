"use client";

import { useCurrentAccount } from "@mysten/dapp-kit";
import { ConnectButton } from "@mysten/dapp-kit";
import { MyPositions } from "@/components/MyPositions";
import { SafeBoundary } from "@/components/SafeBoundary";

export default function PortfolioPage() {
  const account = useCurrentAccount();

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            margin: "0 0 6px",
            color: "var(--primary-dark)",
          }}
        >
          My Portfolio
        </h1>
        <p style={{ color: "var(--text-muted)", margin: 0, fontSize: 14 }}>
          Every bet you have placed on DeepBook Predict, with live account value
          and realized P&amp;L — read straight from on-chain data.
        </p>
      </div>

      {!account ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ color: "var(--text-muted)", margin: "0 0 16px" }}>
            Connect your wallet to see your positions.
          </p>
          <div style={{ display: "inline-block" }}>
            <ConnectButton />
          </div>
        </div>
      ) : (
        <SafeBoundary label="Your positions couldn't be loaded. Please refresh.">
          <MyPositions />
        </SafeBoundary>
      )}
    </div>
  );
}
