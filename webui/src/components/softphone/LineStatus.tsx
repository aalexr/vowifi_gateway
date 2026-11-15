import React from "react";
import type { InstanceStatus } from "../../api";

/** Browser (WebRTC) registration states, as the softphone tracks them. */
export type BrowserReg =
  | "idle"
  | "connecting"
  | "registered"
  | "unregistered"
  | "disconnected"
  | "failed";

// The browser leg borrows the line-state lamps so a colour means the same thing everywhere
// (DESIGN.md, The Lamp Rule): green = up, amber = coming up, red = down, slate = off.
const REG_LAMP: Record<BrowserReg, string> = {
  idle: "REGISTERING",
  connecting: "REGISTERING",
  registered: "OK",
  unregistered: "STOPPED",
  disconnected: "ERROR",
  failed: "ERROR",
};
const REG_LABEL: Record<BrowserReg, string> = {
  idle: "Connecting",
  connecting: "Connecting",
  registered: "Registered",
  unregistered: "Unregistered",
  disconnected: "Disconnected",
  failed: "Registration failed",
};

export const browserRegLabel = (reg: BrowserReg) => REG_LABEL[reg];

interface Props {
  /** The gateway line's own status (IMS registration through the ePDG tunnel). */
  carrier?: InstanceStatus | null;
  reg: BrowserReg;
  /** Compact form for the phone header: lamps with short names, full text in the title. */
  compact?: boolean;
}

/**
 * Both legs of a softphone call: the carrier side (the line's IMS registration, the same lamp
 * as the Dashboard) and the browser side (this tab's WebRTC registration with Asterisk). A
 * call needs both, and they fail independently, so they are never merged into one dot.
 */
export default function LineStatus({ carrier, reg, compact }: Props) {
  const carrierState = carrier?.state || "STOPPED";
  const carrierLabel = carrier?.label || "Unknown";
  const regLabel = REG_LABEL[reg];
  return (
    <div className={`line-status${compact ? " is-compact" : ""}`}>
      <span className="line-status-leg" title={`Carrier (IMS): ${carrierLabel}`}>
        <span className={`dot st-${carrierState}`} aria-hidden="true" />
        <span className="line-status-name">IMS</span>
        <span className="line-status-value">{carrierLabel}</span>
      </span>
      <span className="line-status-leg" title={`Browser (WebRTC): ${regLabel}`}>
        <span className={`dot st-${REG_LAMP[reg]}`} aria-hidden="true" />
        <span className="line-status-name">WebRTC</span>
        <span className="line-status-value">{regLabel}</span>
      </span>
    </div>
  );
}
