import React from "react";
import type { DetectedCard, InstanceConfig } from "../../api";

const LABEL = { color: "var(--text-mute)" };

const Row = ({
  label,
  mono,
  small,
  children,
}: {
  label: string;
  mono?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) => {
  return (
    <>
      <span style={LABEL}>{label}</span>
      <span
        className={mono ? "mono" : undefined}
        style={small ? { fontSize: 11 } : undefined}
      >
        {children}
      </span>
    </>
  );
};

export const LineDetails = ({
  inst,
  card,
}: {
  inst: InstanceConfig;
  card?: DetectedCard;
}) => {
  const d = inst.status?.detail || {};
  return (
    <div
      style={{
        marginTop: 16,
        fontSize: 13,
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: "6px 12px",
        color: "var(--text-soft)",
      }}
    >
      <Row label="Carrier">{`${inst.mcc}-${inst.mnc}`}</Row>
      <Row label="Number" mono>
        {d.msisdn || inst.msisdn || "—"}
      </Row>
      <Row label="IMSI" mono small>
        {inst.imsi || "—"}
      </Row>
      <Row label="ICCID" mono small>
        {card?.iccid || inst.iccid || "—"}
      </Row>
      <Row label="SMSC" mono>
        {d.smsc || inst.smsc || "—"}
      </Row>
      <Row label="P-CSCF" mono small>
        {d.pcscf || "—"}
      </Row>
      <Row label="IMS reg">{d.registration || "—"}</Row>
      <Row label="PIN">
        {d.pin?.state || "—"}
        {d.pin?.tries_left != null ? ` (${d.pin.tries_left} tries)` : ""}
      </Row>
    </div>
  );
};
