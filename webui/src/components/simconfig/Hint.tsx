import React from "react";

/** Small muted help text under a field or group. */
export default function Hint({
  children,
  marginBottom,
}: {
  children: React.ReactNode;
  marginBottom?: number;
}) {
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--text-mute)",
        marginTop: 4,
        marginBottom,
      }}
    >
      {children}
    </div>
  );
}
