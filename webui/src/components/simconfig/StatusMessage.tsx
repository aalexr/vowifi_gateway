import React from "react";

/** Feedback after detect / PIN / save actions. The caller states the tone; it is never guessed
 *  from the wording (an API error can say anything). */
export type StatusTone = "info" | "ok" | "error";
export interface Status {
  text: string;
  tone: StatusTone;
}

export const status = (text: string, tone: StatusTone = "info"): Status => ({
  text,
  tone,
});

/** One-line feedback: neutral while working or when the next step is the user's, green on
 *  success, red on failure. Renders nothing when empty. */
export default function StatusMessage({
  message,
  className,
}: {
  message: Status | null;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div
      role={message.tone === "error" ? "alert" : "status"}
      className={`simcfg-msg simcfg-msg-${message.tone}${className ? ` ${className}` : ""}`}
    >
      {message.text}
    </div>
  );
}
