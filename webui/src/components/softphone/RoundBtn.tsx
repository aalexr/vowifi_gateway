import React from "react";

interface RoundBtnProps {
  icon: React.ReactNode;
  /** Visible caption under the button; also its accessible name. */
  label: string;
  onClick?: () => void;
  /** Toggle buttons (Mute, Keypad, Record) pass their state; plain actions leave it undefined. */
  pressed?: boolean;
  /** "hangup" = the red end-call button; default = neutral control. */
  variant?: "default" | "hangup";
}

/** Round in-call control with its caption. */
export default function RoundBtn({
  icon,
  label,
  onClick,
  pressed,
  variant = "default",
}: RoundBtnProps) {
  return (
    <div className="round-btn-wrap">
      <button
        type="button"
        className={`round-btn${variant === "hangup" ? " is-hangup" : ""}`}
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
      >
        {icon}
      </button>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
