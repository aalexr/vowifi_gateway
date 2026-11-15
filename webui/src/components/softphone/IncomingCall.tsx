import React, { useEffect, useId, useRef } from "react";
import { Phone as PhoneIcon, PhoneOff } from "lucide-react";

interface Props {
  number: string;
  /** The line it's ringing on (the gateway line's name). */
  line: string;
  onAnswer: () => void;
  onDecline: () => void;
}

/**
 * Full-screen incoming-call prompt. An alertdialog with focus on Answer, so a keyboard or
 * screen-reader user hears the call and can take it with one key; Decline sends 603.
 * Vibrates on phones that allow it (ignored elsewhere), since a backgrounded tab has no ring.
 */
export default function IncomingCall({ number, line, onAnswer, onDecline }: Props) {
  const titleId = useId();
  const subId = useId();
  const answerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    answerRef.current?.focus();
    try {
      navigator.vibrate?.([400, 200, 400, 200, 400]);
    } catch {}
    return () => {
      try {
        navigator.vibrate?.(0);
      } catch {}
    };
  }, []);
  return (
    <div className="incoming-scrim">
      <div
        className="card incoming-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subId}
      >
        <div id={titleId} className="mono incoming-number">
          {number || "Unknown"}
        </div>
        <div id={subId} className="incoming-sub">Incoming call on {line}</div>
        <div className="incoming-actions">
          <div className="incoming-action">
            <button
              type="button"
              className="round-btn round-btn-lg is-hangup"
              onClick={onDecline}
              aria-label="Decline"
            >
              <PhoneOff size={28} aria-hidden="true" />
            </button>
            <span aria-hidden="true">Decline</span>
          </div>
          <div className="incoming-action">
            <button
              ref={answerRef}
              type="button"
              className="round-btn round-btn-lg is-answer is-ringing"
              onClick={onAnswer}
              aria-label="Answer"
            >
              <PhoneIcon size={28} aria-hidden="true" />
            </button>
            <span aria-hidden="true">Answer</span>
          </div>
        </div>
      </div>
    </div>
  );
}
