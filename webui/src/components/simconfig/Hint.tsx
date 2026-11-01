import React from "react";

/** Small muted help text under a field or group. */
export default function Hint({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="hint" style={style}>
      {children}
    </div>
  );
}
