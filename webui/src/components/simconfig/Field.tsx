import React, { cloneElement, isValidElement, useId } from "react";

interface FieldProps {
  label: React.ReactNode;
  /** Span the full row of a `.form-grid` (two columns of a `.form-grid-4`). */
  wide?: boolean;
  children: React.ReactNode;
}

/**
 * A labelled form control. The label is tied to the control by id (`htmlFor`), so screen
 * readers name the field and clicking the label focuses it; a child that already carries an
 * id keeps it.
 */
export default function Field({ label, wide, children }: FieldProps) {
  const autoId = useId();
  const el = isValidElement(children)
    ? (children as React.ReactElement<{ id?: string }>)
    : null;
  const id = el?.props.id || autoId;
  const child = el && !el.props.id ? cloneElement(el, { id }) : children;
  return (
    <div className={wide ? "field-wide" : undefined}>
      <label htmlFor={el ? id : undefined}>{label}</label>
      {child}
    </div>
  );
}
