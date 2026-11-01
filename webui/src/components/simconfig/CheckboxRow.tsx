import React from "react";

interface CheckboxRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  marginTop?: number;
}

/** A checkbox with its label text on the same line. */
export default function CheckboxRow({
  checked,
  onChange,
  children,
  marginTop = 4,
}: CheckboxRowProps) {
  return (
    <label style={{ marginTop, display: "flex", alignItems: "center", gap: 8 }}>
      <input
        type="checkbox"
        style={{ width: "auto" }}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}
