import React from "react";
import type { InstanceStatus, StatusState } from "../../api";

export const STEPS: [StatusState, string][] = [
  ["NO_CARD", "SIM"],
  ["EPDG_UNRESOLVED", "ePDG DNS"],
  ["TUNNEL_DOWN", "Tunnel"],
  ["REGISTERING", "IMS reg"],
  ["OK", "Working"],
];
export const RANK: Partial<Record<StatusState, number>> = {
  STOPPED: -1,
  NO_CARD: 0,
  PIN_PROBLEM: 0,
  EPDG_UNRESOLVED: 1,
  TUNNEL_DOWN: 2,
  REGISTERING: 3,
  OK: 4,
};

export default function Pipeline({ st }: { st?: InstanceStatus | null }) {
  const rank = (st && RANK[st.state]) ?? -1;
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
      {STEPS.map(([k, label], idx) => {
        const done = rank > idx;
        const cur = rank === idx;
        const bg = done
          ? "var(--ok-solid)"
          : cur
            ? st?.state === "OK"
              ? "var(--ok-solid)"
              : "#ca8a04"
            : "var(--border-strong)";
        return (
          <div key={k} style={{ flex: 1, textAlign: "center" }}>
            <div style={{ height: 5, borderRadius: 3, background: bg }} />
            <div
              style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 4 }}
            >
              {label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
