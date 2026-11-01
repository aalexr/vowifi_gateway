import React from "react";

export default function StatePill({ state }: { state?: string | null }) {
  const enabled = String(state || "").toLowerCase() === "enabled";
  return (
    <span className={`pill${enabled ? " pill-ok" : ""}`}>
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}
