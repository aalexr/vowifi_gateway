import React, { useState } from "react";
import { api } from "../../api";
import { PIN_RE } from "./utils";

// A PIN prompt shown when starting a line whose card needs a PIN we don't have (deleted,
// or the saved one no longer verifies). Verifies + saves the PIN, then starts the line.
export default function StartPinModal({ inst, tries, error, onClose, onDone }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error || "");
  const ok = PIN_RE.test(pin);

  const submit = async () => {
    if (!ok) {
      setErr("PIN must be 4–8 digits.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.start(inst.id, { pin });
      onDone && (await onDone());
      onClose();
    } catch (e) {
      const code = e?.data?.detail?.code;
      if (code === "pin_invalid" || /PIN error/i.test(e.message)) {
        const t = e?.data?.detail?.tries;
        setErr(`Wrong PIN${t != null ? ` — ${t} tries left` : ""}.`);
      } else if (code === "no_card")
        setErr("SIM card is not present in the reader.");
      else setErr(e.message);
      setPin("");
    }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card"
        style={{ padding: 24, width: 380, maxWidth: "92vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Enter SIM PIN</h2>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-dim)",
            marginBottom: 14,
            lineHeight: 1.6,
          }}
        >
          {inst?.name || `Line ${inst?.id}`} needs its SIM PIN to start (no
          valid saved PIN). The PIN is verified against the card, saved, and
          used to bring the line up.
        </div>
        <input
          type="password"
          inputMode="numeric"
          className="mono"
          value={pin}
          maxLength={8}
          autoFocus
          onChange={(e) => {
            setPin(e.target.value.replace(/[^0-9]/g, ""));
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok) submit();
          }}
          placeholder="4–8 digits"
          style={{ width: "100%" }}
        />
        {tries != null && !err && (
          <div
            style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 6 }}
          >
            {tries} tries left.
          </div>
        )}
        {err && (
          <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 8 }}>
            {err}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 18,
            justifyContent: "flex-end",
          }}
        >
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !ok}
            onClick={submit}
          >
            {busy ? "Starting…" : "Unlock & start"}
          </button>
        </div>
      </div>
    </div>
  );
}
