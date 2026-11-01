import React from "react";
import type { CardInfo } from "../../api";
import CardDetails from "./CardDetails";
import Field from "./Field";
import Hint from "./Hint";
import StatusMessage from "./StatusMessage";
import type { FormSectionProps } from "./types";

interface SimCardPanelProps extends FormSectionProps {
  readers: string[];
  /** Stable USB port path of a reader index ("" when unknown). */
  portForIdx: (i: number) => string;
  card: CardInfo | null;
  pin: string;
  setPin: (pin: string) => void;
  onDetect: () => void;
  onVerifyPin: () => void;
  onDeleteSavedPin: () => void;
  /** Detect / PIN feedback line. */
  message: string;
}

/** Sticky side panel: reader picker, card detection and PIN entry/verification. */
export default function SimCardPanel({
  form,
  upd,
  readers,
  portForIdx,
  card,
  pin,
  setPin,
  onDetect,
  onVerifyPin,
  onDeleteSavedPin,
  message,
}: SimCardPanelProps) {
  return (
    <aside className="card simcfg-card">
      <div className="cfg-section-title">SIM card</div>
      <Field label="Reader">
        <select
          value={form.reader_index}
          onChange={(e) =>
            upd({
              reader_index: +e.target.value,
              reader_port: portForIdx(+e.target.value) || form.reader_port,
            })
          }
        >
          {readers.map((r, i) => (
            <option key={i} value={i}>
              {i}: {r}
              {portForIdx(i) ? ` — USB ${portForIdx(i)}` : ""}
            </option>
          ))}
          {readers.length === 0 && <option>no readers</option>}
        </select>
      </Field>
      {form.reader_port && (
        <Hint>
          Bound to USB port {form.reader_port} (stable across reader
          re-enumeration)
        </Hint>
      )}
      <button
        className="btn btn-ghost"
        style={{ marginTop: 10 }}
        onClick={onDetect}
      >
        Detect card
      </button>
      {card && <CardDetails card={card} />}
      <hr className="cfg-rule" />
      <Field label="PIN (CHV1)">
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="e.g. 123456"
        />
      </Field>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button
          className="btn btn-primary"
          onClick={onVerifyPin}
          disabled={!pin}
        >
          Verify PIN
        </button>
        {form.id && form.has_pin && (
          <button
            className="btn btn-ghost"
            style={{ color: "var(--danger)" }}
            onClick={onDeleteSavedPin}
          >
            Delete saved PIN
          </button>
        )}
      </div>
      {form.id && (
        <Hint style={{ marginTop: 8 }}>
          {form.has_pin
            ? "A PIN is saved for this line and used automatically on start."
            : "No PIN saved — you'll be asked for it when the line is started (if the SIM requires one)."}
        </Hint>
      )}
      <StatusMessage message={message} />
    </aside>
  );
}
