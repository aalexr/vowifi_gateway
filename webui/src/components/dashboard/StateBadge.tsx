import React from "react";
import type { InstanceStatus, StatusState } from "../../api";

export default function StateBadge({
  st,
}: {
  st?: Pick<InstanceStatus, "state" | "label"> | null;
}) {
  const state = st?.state || "STOPPED";
  return (
    <span className={`pill ${STATE_PILL[state] || ""}`}>
      <span className={`dot st-${state}`} />
      {st?.label || "Unknown"}
    </span>
  );
}

export const STATE_PILL: Partial<Record<StatusState, string>> = {
  OK: "pill-ok",
  REGISTERING: "pill-warn",
  TUNNEL_DOWN: "pill-orange",
  EPDG_UNRESOLVED: "pill-orange",
  PIN_PROBLEM: "pill-danger",
  NO_CARD: "pill-danger",
  ERROR: "pill-danger",
};
