import React, { useState } from "react";
import { api, asApiError } from "../../api";
import { useAuth } from "../common/AuthGate";

/** Settings card: who is logged in, log out, log out everywhere. */
export default function SessionCard() {
  const { status, refresh, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const logoutAll = async () => {
    if (!confirm("Log out every browser, including this one?")) return;
    setBusy(true);
    setMsg("");
    try {
      await api.logoutAll();
      await refresh();
    } catch (err) {
      setMsg("Error: " + asApiError(err).message);
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 20 }}>
      <h3 style={{ marginTop: 0 }}>WebUI login</h3>
      <p className="auth-note">
        Logged in as <strong className="mono">{status.user}</strong>, the Linux
        account the gateway runs as. The WebUI password is that account's Linux
        password: change it with <code>passwd</code> on the host. Sessions last 30
        days; a password change doesn't end them, so use <em>Log out everywhere</em>{" "}
        after changing it.
      </p>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          marginTop: 12,
        }}
      >
        <button className="btn btn-ghost" onClick={logout}>
          Log out
        </button>
        <button className="btn btn-ghost" onClick={logoutAll} disabled={busy}>
          Log out everywhere
        </button>
        {msg && (
          <span style={{ fontSize: 13, color: "var(--danger)" }}>{msg}</span>
        )}
      </div>
    </div>
  );
}
