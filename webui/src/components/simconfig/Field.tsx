import React from "react";

interface FieldProps {
  label: React.ReactNode;
  /** Span the full row of a `.form-grid` (two columns of a `.form-grid-4`). */
  wide?: boolean;
  children: React.ReactNode;
}

export default function Field({ label, wide, children }: FieldProps) {
  return (
    <div className={wide ? "field-wide" : undefined}>
      <label>{label}</label>
      {children}
    </div>
  );
}
