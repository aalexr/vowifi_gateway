import React from "react";

// Messages that read as success; anything else is shown as a warning.
const isSuccess = (msg: string) =>
  msg.includes("OK") ||
  msg.includes("read") ||
  msg.startsWith("Saved.") ||
  msg.includes("deleted");

/** One-line feedback after detect / PIN / save actions. Renders nothing when empty. */
export default function StatusMessage({
  message,
  style,
}: {
  message: string;
  style?: React.CSSProperties;
}) {
  if (!message) return null;
  return (
    <div
      role="status"
      style={{
        fontSize: 13,
        marginTop: 10,
        color: isSuccess(message) ? "var(--ok)" : "var(--warn)",
        ...style,
      }}
    >
      {message}
    </div>
  );
}
