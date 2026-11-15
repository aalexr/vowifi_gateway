import React, { useId } from "react";

export type SmscMode = "auto" | "manual";

interface SmscFieldProps {
  value: string;
  onChange: (smsc: string) => void;
  mode: SmscMode;
  /** Called on a mode switch; switching to "auto" should re-apply the SIM's SMSC. */
  onModeChange: (mode: SmscMode) => void;
}

/** SMS centre: read from the SIM (EF_SMSP) or typed by hand. */
export default function SmscField({
  value,
  onChange,
  mode,
  onModeChange,
}: SmscFieldProps) {
  const auto = mode === "auto";
  const id = useId();
  return (
    <div style={{ marginTop: 12 }}>
      <label htmlFor={id}>SMS centre (SMSC)</label>
      <div
        className="segmented"
        role="group"
        aria-label="SMSC source"
        style={{ marginBottom: 6 }}
      >
        <button
          type="button"
          className={`btn${auto ? " is-active" : ""}`}
          aria-pressed={auto}
          onClick={() => onModeChange("auto")}
        >
          Auto (from SIM)
        </button>
        <button
          type="button"
          className={`btn${!auto ? " is-active" : ""}`}
          aria-pressed={!auto}
          onClick={() => onModeChange("manual")}
        >
          Manual
        </button>
      </div>
      <input
        id={id}
        className="mono"
        value={value}
        readOnly={auto}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={auto ? "read from the SIM once it is unlocked" : "+49…"}
      />
    </div>
  );
}
