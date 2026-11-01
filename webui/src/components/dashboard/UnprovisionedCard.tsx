import React, { BaseSyntheticEvent, useState } from "react";
import { api, DetectedCard } from "../../api";
import { PIN_RE } from "./utils";

interface UnprovisionedCardProps {
  card: DetectedCard;
  refresh: () => Promise<void>;
  onProvision: (pin: string) => void;
}

// A detected-but-unprovisioned SIM. Two states:
//  - LOCKED (PIN required, IMSI not yet readable): show basic info + a PIN field, no Provision.
//    Entering a correct PIN unlocks IMSI+SMSC on the backend and the card refreshes.
//  - READY (PIN disabled, or unlocked): show identity + SMSC, offer Provision.
export default function UnprovisionedCard({
  card,
  refresh,
  onProvision,
}: UnprovisionedCardProps) {
  const [pinInput, setPinInput] = useState("");
  const [pin, setPin] = useState(""); // remembered correct PIN, forwarded to provisioning
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const unlocked = !!card.imsi; // could read IMSI => PIN satisfied or disabled
  const pinOk = PIN_RE.test(pinInput);

  const unlock = async (e: BaseSyntheticEvent) => {
    e.stopPropagation();
    if (!pinOk) {
      setErr("PIN must be 4–8 digits.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await api.verifyPin(pinInput, card.index, card.name);
      if (r.ok) {
        setPin(pinInput);
        await refresh();
      } // card entry updates -> re-renders as READY
      else
        setErr(
          `${r.error}${r.tries != null ? ` — ${r.tries} tries left` : ""}`,
        );
    } catch (e2) {
      // @ts-ignore: e2 may not have a message property
      setErr(e2.message);
    }
    setBusy(false);
  };

  const row = (k: string, v: React.ReactNode, mono = false) => (
    <>
      <span style={{ color: "var(--text-mute)" }}>{k}</span>
      <span
        className={mono ? "mono" : ""}
        style={mono ? { fontSize: 11 } : undefined}
      >
        {v}
      </span>
    </>
  );

  if (!unlocked) {
    // LOCKED
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            marginTop: 14,
            fontSize: 13,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "6px 12px",
            color: "var(--text-soft)",
          }}
        >
          {row("ICCID", card.iccid || "—", true)}
          {row(
            "Status",
            <span style={{ color: "var(--warn)" }}>
              🔒 SIM locked — PIN required
            </span>,
          )}
          {card.pin_tries != null && row("PIN tries", card.pin_tries)}
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, color: "var(--text-mute)" }}>
            Enter SIM PIN (CHV1)
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input
              type="password"
              inputMode="numeric"
              value={pinInput}
              maxLength={8}
              onChange={(e) => {
                setPinInput(e.target.value.replace(/[^0-9]/g, ""));
                setErr("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pinOk) unlock(e);
              }}
              placeholder="4–8 digits"
              className="mono"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-primary"
              disabled={busy || !pinOk}
              onClick={unlock}
            >
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </div>
          {pinInput && !pinOk && (
            <div
              style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 6 }}
            >
              PIN must be 4–8 digits.
            </div>
          )}
          {err && (
            <div
              style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 8 }}
            >
              {err}
            </div>
          )}
        </div>
      </div>
    );
  }

  // READY (unlocked or PIN disabled)
  const smscMissing = !card.smsc;
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div
        style={{
          marginTop: 14,
          fontSize: 13,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "6px 12px",
          color: "var(--text-soft)",
        }}
      >
        {row("ICCID", card.iccid || "—", true)}
        {row("IMSI", card.imsi || "—", true)}
        {card.mcc && card.mnc && row("Carrier", `${card.mcc}-${card.mnc}`)}
        {row(
          "SMSC",
          card.smsc ? (
            <span className="mono">
              {card.smsc}{" "}
              <span style={{ color: "var(--text-mute)" }}>· from SIM</span>
            </span>
          ) : (
            <span style={{ color: "var(--warn)" }}>
              ⚠ could not read from SIM — enter manually when provisioning
            </span>
          ),
        )}
        {row("PIN", card.pin_enabled === false ? "disabled" : "unlocked ✓")}
      </div>
      <button
        className="btn btn-primary"
        style={{ marginTop: 16 }}
        onClick={(e) => {
          e.stopPropagation();
          onProvision(pin);
        }}
      >
        Provision this SIM{smscMissing ? " (enter SMSC)" : ""}
      </button>
    </div>
  );
}
