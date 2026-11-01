import React, { useEffect, useState } from "react";

interface SectionProps {
  title: React.ReactNode;
  desc?: React.ReactNode;
  /** Render as a foldable <details>; `false` gives a plain always-open card. */
  collapsible?: boolean;
  /** Initial open state (re-applied whenever `resetKey` changes). */
  defaultOpen?: boolean;
  /** Typically the line id: switching lines re-applies `defaultOpen`. */
  resetKey?: unknown;
  children: React.ReactNode;
}

/**
 * One titled block of the line form. Collapsible sections open by default when something in
 * them is already set, so nothing is hidden that differs from the defaults. The open state then
 * belongs to the user until the line changes (resetKey), so clearing a field doesn't snap the
 * section shut mid-edit.
 */
export default function Section({
  title,
  desc,
  collapsible = true,
  defaultOpen,
  resetKey,
  children,
}: SectionProps) {
  const [open, setOpen] = useState(!!defaultOpen);
  useEffect(() => {
    setOpen(!!defaultOpen);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const head = (
    <>
      <div className="cfg-section-title">{title}</div>
      {desc && <div className="cfg-section-desc">{desc}</div>}
    </>
  );
  if (!collapsible)
    return (
      <section className="card cfg-section">
        <header>{head}</header>
        {children}
      </section>
    );
  return (
    <details
      className="card cfg-section"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{head}</summary>
      <div className="cfg-section-body">{children}</div>
    </details>
  );
}
