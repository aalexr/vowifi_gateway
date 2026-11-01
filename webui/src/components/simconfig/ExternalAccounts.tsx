import React from "react";
import type { SipExternalAccount } from "../../api";
import Hint from "./Hint";

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
    <>
      <div className="cfg-subhead">External SIP accounts</div>
      <Hint style={{ marginTop: 0, marginBottom: 8 }}>
        Each account needs a unique username and cannot reuse an Asterisk or
        WebRTC name.
      </Hint>
      {accounts.map((a, i) => (
        <div key={i} className="sip-account-row">
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
          style={{ color: "var(--danger)", fontSize: 12.5, marginBottom: 6 }}
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
    </>
  );
}
