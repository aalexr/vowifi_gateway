import React from "react";
import { Plus } from "lucide-react";
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
        Unique usernames, not reusing the Asterisk or WebRTC name.
      </Hint>
      {accounts.map((a, i) => (
        <div key={i} className="sip-account-row">
          <input
            aria-label={`Account ${i + 1} username`}
            autoComplete="off"
            placeholder="username"
            value={a.username}
            onChange={(e) => setField(i, "username", e.currentTarget.value)}
          />
          <input
            type="password"
            aria-label={`Account ${i + 1} password`}
            autoComplete="new-password"
            placeholder="password"
            value={a.password}
            onChange={(e) => setField(i, "password", e.currentTarget.value)}
          />
        </div>
      ))}
      {error && (
        <div className="simcfg-msg simcfg-msg-error" role="alert" style={{ marginTop: 0, marginBottom: 6 }}>
          {error}
        </div>
      )}
      <button
        className="btn btn-ghost"
        onClick={() => onChange([...accounts, { username: "", password: "" }])}
      >
        <Plus size={16} aria-hidden /> Add account
      </button>
    </>
  );
}
