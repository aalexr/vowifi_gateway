import React, { useEffect, useState } from "react";
import type { InstanceStatus } from "../../api";
import CardDetails from "./CardDetails";
import Field from "./Field";
import Hint from "./Hint";
import StatusMessage, { type Status } from "./StatusMessage";
import { pinEnabled, pinGuard, pinNeeded, type CardFacts } from "./pin";
import type { FormSectionProps } from "./types";

interface SimCardPanelProps extends FormSectionProps {
  readers: string[];
  /** The reader index actions run against (clamped to a reader that exists). */
  readerIdx: number;
  /** Stable USB port path of a reader index ("" when unknown). */
  portForIdx: (i: number) => string;
  /** What is known about the card in that reader (pin.ts `cardFacts`). */
  facts: CardFacts | null;
  /** Remaining PIN attempts, or null when no source knows them. */
  tries: number | null;
  /** The saved line's live status (PIN_PROBLEM opens PIN entry; running lines are named). */
  lineStatus?: InstanceStatus | null;
  pin: string;
  setPin: (pin: string) => void;
  busy: boolean;
  onDetect: () => void;
  onVerifyPin: () => void;
  onDeleteSavedPin: () => void;
  /** Detect / PIN feedback line. */
  message: Status | null;
}

/**
 * Side panel: reader picker, the card's facts, and PIN handling.
 *
 * PIN entry is a guarded step, not a standing form: it appears only when the line reports a
 * PIN problem, the card is locked, or the user asks to save/replace the PIN. Verify needs a
 * known attempt count (read from the card monitor or "Detect card"), is closed at 0, and the
 * last attempt has to be acknowledged, so a typo can never block a SIM unannounced.
 */
export default function SimCardPanel({
  form,
  upd,
  readers,
  readerIdx,
  portForIdx,
  facts,
  tries,
  lineStatus,
  pin,
  setPin,
  busy,
  onDetect,
  onVerifyPin,
  onDeleteSavedPin,
  message,
}: SimCardPanelProps) {
  const needed = pinNeeded(facts, lineStatus);
  const [asked, setAsked] = useState(false);
  const [lastOk, setLastOk] = useState(false);
  // A different line or reader starts closed again (unless it needs the PIN).
  useEffect(() => {
    setAsked(false);
    setLastOk(false);
  }, [form.id, readerIdx]);

  const guard = pinGuard(tries);
  const enabled = pinEnabled(facts, lineStatus);
  const pinOff = !!facts?.present && enabled === false;
  const open = (needed || asked) && !pinOff && facts?.present !== false;
  const canVerify =
    !!pin &&
    !busy &&
    (guard === "ok" || guard === "low" || (guard === "last" && lastOk));
  const boundHere = !!form.reader_port && form.reader_port === portForIdx(readerIdx);

  return (
    <aside className="card simcfg-card" aria-label="SIM card">
      <div className="cfg-section-title simcfg-card-title">SIM card</div>
      <Field label="Reader">
        <select
          value={readerIdx}
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
        <Hint>
          {boundHere
            ? `Line bound to this reader's USB port ${form.reader_port}.`
            : `Line bound to USB port ${form.reader_port}, not this reader.`}
        </Hint>
      )}
      {facts && (
        <CardDetails
          facts={facts}
          readerIdx={readerIdx}
          tries={tries}
          enabled={enabled}
        />
      )}
      <button
        className="btn btn-ghost"
        style={{ marginTop: 12 }}
        onClick={onDetect}
        disabled={busy || readers.length === 0}
      >
        {facts?.present ? "Read card into form" : "Detect card"}
      </button>

      <hr className="cfg-rule" />
      <div className="simcfg-pin-head">
        <span className="simcfg-pin-title">PIN</span>
        {form.id && (
          <span className="simcfg-pin-saved">
            {form.has_pin ? "saved, used on start" : "not saved"}
          </span>
        )}
      </div>

      {open ? (
        <div className="simcfg-pin">
          {lineStatus?.state === "PIN_PROBLEM" && (
            <Hint style={{ marginTop: 0, marginBottom: 8 }}>
              {lineStatus.reason || "The line can't unlock the SIM."}
            </Hint>
          )}
          <Field label="PIN (CHV1)">
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, ""))}
              maxLength={8}
              disabled={guard === "blocked" || guard === "unknown"}
            />
          </Field>
          {guard === "unknown" && (
            <div className="banner banner-warn simcfg-pin-guard">
              Remaining attempts unknown. Detect the card first, so a wrong PIN
              can't block it unannounced.
            </div>
          )}
          {guard === "blocked" && (
            <div className="banner banner-danger simcfg-pin-guard" role="alert">
              PIN blocked. Unblock the SIM with its PUK in a phone; this page
              won't try again.
            </div>
          )}
          {guard === "low" && (
            <div className="banner banner-warn simcfg-pin-guard">
              2 attempts left. After two wrong PINs the SIM needs its PUK.
            </div>
          )}
          {guard === "last" && (
            <div className="banner banner-danger simcfg-pin-guard">
              <label className="cfg-check" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={lastOk}
                  onChange={(e) => setLastOk(e.currentTarget.checked)}
                />
                <span>
                  Last attempt. A wrong PIN now blocks the SIM until the PUK is
                  entered. I&apos;m sure of this PIN.
                </span>
              </label>
            </div>
          )}
          <div className="simcfg-pin-actions">
            <button
              className="btn btn-ghost"
              onClick={onVerifyPin}
              disabled={!canVerify}
            >
              Verify PIN
              {guard === "ok" || guard === "low" || guard === "last"
                ? ` · ${tries} left`
                : ""}
            </button>
            {!needed && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setAsked(false);
                  setPin("");
                }}
              >
                Cancel
              </button>
            )}
          </div>
          <Hint>
            A verified PIN is saved with the line on Save and used on every
            start.
          </Hint>
        </div>
      ) : (
        <div className="simcfg-pin-actions">
          {!pinOff && facts?.present && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAsked(true)}
            >
              {form.has_pin ? "Replace saved PIN…" : "Enter PIN…"}
            </button>
          )}
          {pinOff && <Hint style={{ marginTop: 0 }}>The SIM has no PIN set.</Hint>}
        </div>
      )}
      {form.id && form.has_pin && (
        <button
          type="button"
          className="link-btn simcfg-pin-forget"
          onClick={onDeleteSavedPin}
          disabled={busy}
        >
          Forget saved PIN (stops the line)
        </button>
      )}
      <StatusMessage message={message} />
    </aside>
  );
}
