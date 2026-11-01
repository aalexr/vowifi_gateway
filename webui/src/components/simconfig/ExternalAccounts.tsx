import React from "react";
import type { SipExternalAccount } from "../../api";

interface ExternalAccountsProps {
  accounts: SipExternalAccount[];
  onChange: (accounts: SipExternalAccount[]) => void;
  /** Validation message from `sipUsernameConflict`, or "". */
  error: string;
}

/** Editable list of extra SIP accounts local phones can register with. */
export default function ExternalAccounts({
  accounts,
  onChange,
  error,
}: ExternalAccountsProps) {
  const setField = (i: number, k: keyof SipExternalAccount, v: string) =>
    onChange(accounts.map((a, idx) => (idx === i ? { ...a, [k]: v } : a)));

  return (
    <div style={{ marginTop: 12 }}>
      <label>External SIP accounts</label>
      <div style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 6 }}>
        Each account needs a unique username and cannot reuse an Asterisk or
        WebRTC name.
      </div>
      {accounts.map((a, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            placeholder="username"
            value={a.username}
            onChange={(e) => setField(i, "username", e.target.value)}
          />
          <input
            type="password"
            placeholder="password"
            value={a.password}
            onChange={(e) => setField(i, "password", e.target.value)}
          />
        </div>
      ))}
      {error && (
        <div
          style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 6 }}
          role="alert"
        >
          {error}
        </div>
      )}
      <button
        className="btn btn-ghost"
        onClick={() => onChange([...accounts, { username: "", password: "" }])}
      >
        + Add account
      </button>
    </div>
  );
}
