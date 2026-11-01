import React from "react";
import Field from "./Field";

export type SmscMode = "auto" | "manual";

interface SmscFieldProps {
  value: string;
  onChange: (smsc: string) => void;
  mode: SmscMode;
  /** Called on a mode switch; switching to "auto" should re-apply the SIM's SMSC. */
  onModeChange: (mode: SmscMode) => void;
}

const radioLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  cursor: "pointer",
};

/** SMS centre: read from the SIM (EF_SMSP) or typed by hand. */
export default function SmscField({
  value,
  onChange,
  mode,
  onModeChange,
}: SmscFieldProps) {
  const auto = mode === "auto";
  return (
    <Field label="SMS centre (SMSC)">
      <div style={{ display: "flex", gap: 12, marginBottom: 6, fontSize: 13 }}>
        <label style={radioLabel}>
          <input
            type="radio"
            name="scmode"
            checked={auto}
            style={{ width: "auto" }}
            onChange={() => onModeChange("auto")}
          />
          Auto (from SIM)
        </label>
        <label style={radioLabel}>
          <input
            type="radio"
            name="scmode"
            checked={!auto}
            style={{ width: "auto" }}
            onChange={() => onModeChange("manual")}
          />
          Manual
        </label>
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
    </Field>
  );
}
