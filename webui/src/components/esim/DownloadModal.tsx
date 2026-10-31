import React, { useState, useEffect } from "react";
import { api } from "../../api";
import { X } from "lucide-react";
import { parseActivationCode, formatBytes } from "./utils";

export default function DownloadModal({
  reader,
  ses,
  imeiDefault,
  onClose,
  onStarted,
  showToast,
}) {
  const dual = (ses || []).length > 1;
  const [mode, setMode] = useState("code"); // code | manual
  const [activation, setActivation] = useState("");
  const [smdp, setSmdp] = useState("");
  const [matchingId, setMatchingId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [imei, setImei] = useState(imeiDefault || "");
  const [seId, setSeId] = useState(dual ? "" : ses?.[0]?.id || "default");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const parsed = parseActivationCode(activation);
    if (parsed) {
      setSmdp(parsed.smdp);
      setMatchingId(parsed.matching_id);
    }
  }, [activation]);

  const submit = async () => {
    setErr("");
    if (dual && !seId)
      return setErr("Select which eUICC (SE) to install onto.");
    const body: Record<string, string | undefined> = {
      reader,
      se_id: seId || ses?.[0]?.id || "default",
      imei: imei.trim() || undefined,
      confirmation_code: confirmation.trim() || undefined,
    };
    if (mode === "code") {
      if (!activation.trim())
        return setErr("Paste an activation code (LPA:1$…).");
      body.activation_code = activation.trim();
    } else {
      if (!smdp.trim()) return setErr("SM-DP+ address is required.");
      body.smdp = smdp.trim();
      body.matching_id = matchingId.trim() || undefined;
    }
    setBusy(true);
    try {
      await api.esimDownload(body);
      onStarted?.();
      onClose();
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card"
        style={{ width: 480, maxWidth: "92vw", padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>Download eSIM profile</h2>
          <button
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        {dual && (
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-mute)",
                marginBottom: 6,
              }}
            >
              eUICC
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(ses || []).map((se, i) => {
                const selected = seId === se.id;
                return (
                  <button
                    key={se.id}
                    type="button"
                    onClick={() => setSeId(se.id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      cursor: "pointer",
                      border: `1px solid ${selected ? "var(--primary)" : "var(--border)"}`,
                      borderRadius: 10,
                      padding: "8px 10px",
                      background: selected
                        ? "color-mix(in srgb, var(--primary) 8%, var(--panel))"
                        : "transparent",
                      color: "inherit",
                      font: "inherit",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 12,
                        wordBreak: "break-all",
                      }}
                    >
                      {se.eid || `SE${i + 1} (no EID)`}
                    </span>
                    <span
                      style={{
                        display: "block",
                        fontSize: 12,
                        color: "var(--text-mute)",
                        marginTop: 2,
                      }}
                    >
                      {se.label || `SE${i + 1}`} · Storage Remaining{" "}
                      {formatBytes(se.freeSpace)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="segmented" style={{ marginBottom: 12 }}>
          {[
            ["code", "Activation code"],
            ["manual", "Manual"],
          ].map(([k, label]) => (
            <button
              key={k}
              className={`btn${mode === k ? " is-active" : ""}`}
              onClick={() => setMode(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "code" ? (
          <label style={{ display: "block", marginBottom: 10 }}>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-mute)",
                marginBottom: 4,
              }}
            >
              LPA activation code
            </div>
            <textarea
              value={activation}
              onChange={(e) => setActivation(e.target.value)}
              rows={3}
              placeholder="LPA:1$smdp.example.com$MATCHING-ID"
              style={{ width: "100%", resize: "vertical" }}
            />
          </label>
        ) : (
          <>
            <label style={{ display: "block", marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-mute)",
                  marginBottom: 4,
                }}
              >
                SM-DP+
              </div>
              <input
                value={smdp}
                onChange={(e) => setSmdp(e.target.value)}
                placeholder="smdp.example.com"
                style={{ width: "100%" }}
              />
            </label>
            <label style={{ display: "block", marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-mute)",
                  marginBottom: 4,
                }}
              >
                Matching ID
              </div>
              <input
                value={matchingId}
                onChange={(e) => setMatchingId(e.target.value)}
                style={{ width: "100%" }}
              />
            </label>
          </>
        )}
        <label style={{ display: "block", marginBottom: 10 }}>
          <div
            style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 4 }}
          >
            Confirmation code (optional)
          </div>
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 10 }}>
          <div
            style={{ fontSize: 12, color: "var(--text-mute)", marginBottom: 4 }}
          >
            IMEI {imeiDefault ? "(from matched line — editable)" : "(optional)"}
          </div>
          <input
            value={imei}
            onChange={(e) => setImei(e.target.value)}
            placeholder="15-digit IMEI"
            style={{ width: "100%" }}
          />
        </label>
        {err && (
          <div
            style={{ color: "var(--danger)", fontSize: 13, marginBottom: 10 }}
          >
            {err}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || (dual && !seId)}
            onClick={submit}
          >
            {busy ? "Starting…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
}
