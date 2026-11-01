import React from "react";

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
  return (
    <div style={{ marginTop: 12 }}>
      <label>SMS centre (SMSC)</label>
      <div className="segmented" style={{ marginBottom: 6 }}>
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
        className="mono"
        value={value}
        readOnly={auto}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          auto ? "detect card / verify PIN to read from SIM" : "+1..."
        }
        style={auto ? { opacity: 0.7 } : undefined}
      />
    </div>
  );
}
