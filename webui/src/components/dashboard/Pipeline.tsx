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

// Solid lamp colour of the step a line is stuck at: the same colour as its state pill/dot.
const LAMP: Partial<Record<StatusState, string>> = {
  NO_CARD: "var(--lamp-danger)",
  PIN_PROBLEM: "var(--lamp-danger)",
  EPDG_UNRESOLVED: "var(--lamp-tunnel)",
  TUNNEL_DOWN: "var(--lamp-tunnel)",
  REGISTERING: "var(--lamp-registering)",
  OK: "var(--lamp-ok)",
};

export const Pipeline = ({ st }: { st?: InstanceStatus | null }) => {
  const rank = (st && RANK[st.state]) ?? -1;
  return (
    <ol
      aria-label="Line progress"
      style={{
        display: "flex",
        gap: 6,
        margin: "12px 0 0",
        padding: 0,
        listStyle: "none",
      }}
    >
      {STEPS.map(([k, label], idx) => {
        const done = rank > idx;
        const cur = rank === idx;
        const bg = done
          ? "var(--lamp-ok)"
          : cur
            ? (st && LAMP[st.state]) || "var(--lamp-registering)"
            : "var(--border-strong)";
        return (
          <li
            key={k}
            aria-current={cur ? "step" : undefined}
            style={{ flex: 1, minWidth: 0, textAlign: "center" }}
          >
            <div style={{ height: 5, borderRadius: 3, background: bg }} />
            <div
              style={{
                fontSize: 10,
                marginTop: 4,
                color: cur ? "var(--text-soft)" : "var(--text-mute)",
                fontWeight: cur ? 600 : 400,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {label}
            </div>
          </li>
        );
      })}
    </ol>
  );
};
