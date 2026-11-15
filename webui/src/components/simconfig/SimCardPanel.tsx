import React from "react";
import type { CardInfo } from "../../api";
import CardDetails from "./CardDetails";
import Field from "./Field";
import Hint from "./Hint";
import StatusMessage, { type Status } from "./StatusMessage";
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
  message: Status | null;
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
      <div className="cfg-section-title simcfg-card-title">SIM card</div>
      <Field label="Reader">
        <select
          value={form.reader_index}
          onChange={(e) =>
            upd({
              reader_index: +e.currentTarget.value,
              reader_port:
                portForIdx(+e.currentTarget.value) || form.reader_port,
            })
          }
        >
          {readers.map((r, i) => (
            <option key={i} value={i}>
              {i} · {portForIdx(i) ? `USB ${portForIdx(i)} · ` : ""}
              {r}
            </option>
          ))}
          {readers.length === 0 && <option>no readers</option>}
        </select>
      </Field>
      {form.reader_port && (
        <Hint>Bound to USB port {form.reader_port}</Hint>
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
          onChange={(e) => setPin(e.currentTarget.value)}
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
            ? "PIN saved; used on start."
            : "No PIN saved; asked on start if the SIM needs one."}
        </Hint>
      )}
      <StatusMessage message={message} />
    </aside>
  );
}
