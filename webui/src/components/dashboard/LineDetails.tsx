import React from "react";
import type { DetectedCard, InstanceConfig, PinStatus } from "../../api";

const LABEL = { color: "var(--text-mute)" };

const GRID: React.CSSProperties = {
  fontSize: 13,
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  gap: "6px 12px",
  color: "var(--text-soft)",
};

const Row = ({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) => {
  return (
    <>
      <span style={LABEL}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={{
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </span>
    </>
  );
};

// A SIM's CHV1 starts with 3 attempts; fewer means a wrong PIN was entered at some point.
const PIN_TRIES_FULL = 3;

// PIN is worth a row only when it needs attention: not verified/disabled, or tries used up.
function pinNeedsAttention(pin?: Partial<PinStatus>) {
  if (!pin?.state) return false;
  if (pin.state !== "VERIFIED" && pin.state !== "PIN_DISABLED") return true;
  return pin.tries_left != null && pin.tries_left < PIN_TRIES_FULL;
}

// What a line's card always shows (number, carrier, a PIN that needs attention), plus the
// SIM/network identifiers behind a disclosure. Registration state is not repeated here:
// the state pill and the reason banner already say it.
export const LineDetails = ({
  inst,
  card,
}: {
  inst: InstanceConfig;
  card?: DetectedCard;
}) => {
  const d = inst.status?.detail || {};
  return (
    <div style={{ marginTop: 16 }}>
      <div style={GRID}>
        <Row label="Number" mono>
          {d.msisdn || inst.msisdn || "—"}
        </Row>
        <Row label="Carrier" mono>{`${inst.mcc}-${inst.mnc}`}</Row>
        {pinNeedsAttention(d.pin) && (
          <Row label="PIN">
            <span style={{ color: "var(--warn)" }}>
              {d.pin?.state}
              {d.pin?.tries_left != null
                ? ` (${d.pin.tries_left} tries left)`
                : ""}
            </span>
          </Row>
        )}
      </div>
      {/* Selecting the card on click would fight the toggle, so keep clicks inside. */}
      <details className="line-ids" onClick={(e) => e.stopPropagation()}>
        <summary>SIM &amp; network</summary>
        <div style={GRID}>
          <Row label="IMSI" mono>
            {inst.imsi || "—"}
          </Row>
          <Row label="ICCID" mono>
            {card?.iccid || inst.iccid || "—"}
          </Row>
          <Row label="SMSC" mono>
            {d.smsc || inst.smsc || "—"}
          </Row>
          <Row label="P-CSCF" mono>
            {d.pcscf || "—"}
          </Row>
        </div>
      </details>
    </div>
  );
};
