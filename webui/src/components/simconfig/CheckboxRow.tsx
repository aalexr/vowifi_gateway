import React from "react";

interface CheckboxRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}

/** A checkbox with its (possibly wrapping) label text beside it. */
export default function CheckboxRow({
  checked,
  onChange,
  children,
}: CheckboxRowProps) {
  return (
    <label className="cfg-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}
