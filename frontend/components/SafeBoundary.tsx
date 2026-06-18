"use client";

import React, { ReactNode } from "react";

type SafeBoundaryProps = { children: ReactNode; label?: string };
type SafeBoundaryState = { hasError: boolean; msg: string };

export class SafeBoundary extends React.Component<SafeBoundaryProps, SafeBoundaryState> {
  constructor(props: SafeBoundaryProps) {
    super(props);
    this.state = { hasError: false, msg: "" };
  }

  static getDerivedStateFromError(error: unknown): SafeBoundaryState {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, msg };
  }

  componentDidCatch(error: unknown) {
    console.error("SafeBoundary caught:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="card" style={{ padding: 12, fontSize: 11, color: "#dc2626", wordBreak: "break-all" }}>
          {this.props.label || "Section unavailable"}
          <div style={{ marginTop: 6, fontFamily: "monospace", color: "#991b1b" }}>
            {this.state.msg}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
