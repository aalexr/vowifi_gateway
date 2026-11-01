import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  asApiError,
  type EsimDownloadPreview,
  type EsimNotification,
  type EsimProfile,
  type EsimSecureElement,
  type EsimStatus,
} from "../api";

/** Live state of an in-flight profile download, driven by `esim_download` WS events. */
interface DownloadState {
  step?: string | null;
  event: string;
  metadata?: EsimDownloadPreview;
  error?: string;
  done?: boolean;
  result?: unknown;
}

interface RenameTarget {
  se: EsimSecureElement;
  profile: EsimProfile;
}
import {
  resolveDownloadStep,
  isNonEuiccError,
  copyText,
  profileDisplayName,
  formatBytes,
  seTarget,
  instanceForCard,
  isLineRunning,
} from "../components/esim/utils";
import StatePill from "../components/esim/StatePill";
import RenameModal from "../components/esim/RenameModal";
import ProgressBar from "../components/esim/ProgressBar";
import DownloadModal from "../components/esim/DownloadModal";
import { CommonViewProps } from "./common-view-props";

export default function Esim({
  cards,
  instances,
  refresh,
  subscribe,
  showToast,
}: CommonViewProps) {
  const present = useMemo(
    () =>
      [...cards]
        .filter((c) => c.present)
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
    [cards],
  );
  const [reader, setReader] = useState("");
  const [status, setStatus] = useState<Partial<EsimStatus> | null>(null);
  const [ses, setSes] = useState<EsimSecureElement[]>([]);
  const [meta, setMeta] = useState({ imei: "" });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [showDl, setShowDl] = useState(false);
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [busyOp, setBusyOp] = useState("");

  useEffect(() => {
    if (!reader && present[0]) setReader(present[0].name);
    if (reader && !present.find((c) => c.name === reader) && present[0])
      setReader(present[0].name);
  }, [present, reader]);

  const selectedCard = present.find((c) => c.name === reader);
  const matchedInst = useMemo(
    () => instanceForCard(selectedCard, instances),
    [selectedCard, instances],
  );
  const lineRunning = isLineRunning(matchedInst);
  const imeiDefault = meta.imei || matchedInst?.imei || "";
  const dual = ses.length > 1;
  const profiles = useMemo(() => ses.flatMap((se) => se.profiles || []), [ses]);
  const notifications = useMemo(
    () => ses.flatMap((se) => se.notifications || []),
    [ses],
  );
  const hasEuicc = ses.some(
    (se) => se.eid || se.chip || (se.profiles || []).length,
  );

  // Lightweight: lpac presence only — never touch the card on page enter / reader switch.
  useEffect(() => {
    let cancelled = false;
    api
      .esimStatus()
      .then((st) => {
        if (!cancelled) setStatus(st);
      })
      .catch(() => {
        if (!cancelled) setStatus({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSes([]);
    setMeta({ imei: "" });
    setLoaded(false);
    setErr("");
    setDl(null);
    setRenameTarget(null);
  }, [reader]);

  const loadAll = useCallback(async () => {
    if (!reader) return;
    setLoading(true);
    setErr("");
    setSes([]);
    setMeta({ imei: "" });
    try {
      const st = await api.esimStatus();
      setStatus(st);
      if (!st.available) {
        setErr(
          'lpac is not installed. Run "sudo ./install.sh build-lpac" on the host.',
        );
        setLoaded(false);
        return;
      }
      // One call loads every SE (chip + profiles + notifications).
      const c = await api.esimChip(reader);
      const list = c.ses || [];
      setSes(list);
      setMeta({ imei: c.imei || "" });
      const seErr = list.map((s) => s.error).filter(Boolean);
      if (!list.length) {
        setErr("");
      } else if (
        list.every((s) => s.error) &&
        seErr.every((m) => isNonEuiccError(m))
      ) {
        setErr("");
      } else if (list.every((s) => s.error)) {
        setErr(seErr[0] || "eUICC load failed");
      } else {
        setErr("");
      }
      setLoaded(true);
    } catch (err) {
      const e = asApiError(err);
      // Non-eUICC cards surface as a calm empty state, not a red error banner.
      setErr(isNonEuiccError(e.message) ? "" : e.message);
      setSes([]);
      setMeta({ imei: "" });
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [reader]);

  const requestLoad = useCallback(async () => {
    if (!reader || loading || busyOp) return;
    if (lineRunning && matchedInst) {
      const label = matchedInst.name
        ? `line ${matchedInst.id} (${matchedInst.name})`
        : `line ${matchedInst.id}`;
      const ok = confirm(
        `VoWiFi ${label} is running on this reader.\n\n` +
          "Loading eSIM info needs exclusive PC/SC access and will stop the line.\n\n" +
          "Stop VoWiFi and Load?",
      );
      if (!ok) return;
      setBusyOp("stop");
      try {
        await api.stop(matchedInst.id);
        showToast?.(`Line ${matchedInst.id} stopped`);
        await refresh?.();
      } catch (e) {
        showToast?.(asApiError(e).message);
        setBusyOp("");
        return;
      }
      setBusyOp("");
    }
    await loadAll();
  }, [
    reader,
    loading,
    busyOp,
    lineRunning,
    matchedInst,
    loadAll,
    refresh,
    showToast,
  ]);

  useEffect(() => {
    if (!subscribe) return undefined;
    return subscribe((msg) => {
      if (msg.type !== "esim_download") return;
      if (reader && msg.reader && msg.reader !== reader) return;
      if (msg.event === "started") {
        setDl({ step: "started", event: "started", done: false });
      } else if (msg.event === "progress" || msg.event === "preview") {
        // lpac emits cancel_session progress on failure — ignore non-pipeline steps so the bar
        // does not jump back to step 1 before the error event arrives.
        const known = resolveDownloadStep(msg.step);
        setDl((d) => ({
          ...(d || {}),
          step: known || d?.step || "started",
          event: msg.event,
          metadata: msg.metadata || d?.metadata,
          done: false,
        }));
      } else if (msg.event === "completed") {
        setDl((d) => ({
          ...(d || {}),
          step: "completed",
          event: "completed",
          done: true,
          result: msg.result,
        }));
        showToast?.("Profile downloaded");
        loadAll();
        refresh?.();
      } else if (msg.event === "error") {
        // Prefer lpac failing function name when it maps to a pipeline step; else keep last progress.
        const known = resolveDownloadStep(msg.step);
        setDl((d) => ({
          ...(d || {}),
          step: known || resolveDownloadStep(d?.step) || d?.step || "started",
          event: "error",
          error: msg.error,
          done: false,
        }));
        showToast?.(msg.error || "Download failed");
      } else if (msg.event === "cancelling") {
        setDl((d) => ({ ...(d || {}), event: "cancelling" }));
      }
    });
  }, [subscribe, reader, loadAll, refresh, showToast]);

  const stopLine = async () => {
    if (!matchedInst) return;
    setBusyOp("stop");
    try {
      await api.stop(matchedInst.id);
      showToast?.(`Line ${matchedInst.id} stopped`);
      await refresh?.();
    } catch (e) {
      showToast?.(asApiError(e).message);
    }
    setBusyOp("");
  };

  const runProfileOp = async (label: string, fn: () => Promise<unknown>) => {
    setBusyOp(label);
    try {
      await fn();
      showToast?.(label + " OK");
      await loadAll();
      await refresh?.();
    } catch (err) {
      const e = asApiError(err);
      showToast?.(e.message);
      setErr(e.message);
    }
    setBusyOp("");
  };

  if (!present.length) {
    return (
      <div className="card" style={{ padding: 24, color: "var(--text-dim)" }}>
        No SIM present. Insert an eUICC into a PC/SC reader to manage profiles.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 600,
          }}
        >
          Reader
          <select
            value={reader}
            onChange={(e) => setReader(e.target.value)}
            style={{ minWidth: 220 }}
          >
            {present.map((c) => (
              <option key={c.name} value={c.name}>
                #{c.index} · {c.name}
                {c.iccid ? ` · ${c.iccid}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn-ghost"
          onClick={requestLoad}
          disabled={loading || !!busyOp}
        >
          {loading ? "Loading…" : "Load"}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => setShowDl(true)}
          disabled={
            !status?.available ||
            !loaded ||
            lineRunning ||
            !!busyOp ||
            (!!dl && !dl.done && !dl.error)
          }
        >
          Download profile
        </button>
      </div>

      {lineRunning && (
        <div className="banner banner-warn" style={{ padding: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontWeight: 700 }}>
                VoWiFi running on this reader
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
                Click Load to stop the line and read eSIM info — lpac needs
                exclusive PC/SC access.
                {matchedInst
                  ? ` (line ${matchedInst.id}${matchedInst.name ? ` · ${matchedInst.name}` : ""})`
                  : ""}
              </div>
            </div>
            <button
              className="btn btn-primary"
              onClick={stopLine}
              disabled={busyOp === "stop" || !matchedInst}
            >
              {busyOp === "stop" ? "Stopping…" : "Stop line"}
            </button>
          </div>
        </div>
      )}

      {err && (
        <div
          className="banner banner-danger"
          role="alert"
          style={{ padding: 14 }}
        >
          {err}
        </div>
      )}

      {dl && (
        <div className="card" style={{ padding: 16 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700 }}>
              {dl.done
                ? "Download complete"
                : dl.error
                  ? "Download failed"
                  : dl.event === "cancelling"
                    ? "Cancelling…"
                    : "Downloading…"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {!dl.done && !dl.error && (
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    api
                      .esimDownloadCancel({ reader })
                      .catch((e) => showToast?.(e.message))
                  }
                >
                  Cancel
                </button>
              )}
              {(dl.done || dl.error) && (
                <button className="btn btn-ghost" onClick={() => setDl(null)}>
                  Dismiss
                </button>
              )}
            </div>
          </div>
          <ProgressBar step={dl.step} done={dl.done} error={dl.error} />
          {dl.metadata && (
            <div
              style={{ marginTop: 12, fontSize: 13, color: "var(--text-soft)" }}
            >
              Preview:{" "}
              {dl.metadata.profileName ||
                dl.metadata.serviceProviderName ||
                "profile"}
              {dl.metadata.iccid ? ` · ${dl.metadata.iccid}` : ""}
            </div>
          )}
          {dl.error && (
            <div
              style={{ marginTop: 10, color: "var(--danger)", fontSize: 13 }}
            >
              {dl.error}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Chip</div>
        {!hasEuicc ? (
          <div
            style={{ color: "var(--text-mute)", fontSize: 13, lineHeight: 1.5 }}
          >
            {status && !status.available
              ? 'lpac is not installed. Run "sudo ./install.sh build-lpac" on the host.'
              : loading
                ? "Reading…"
                : !loaded
                  ? "Click Load to read chip info from this card (uses lpac / PC/SC)."
                  : "This card is not an eUICC / eSIM. Ordinary USIM cards cannot be managed here."}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              fontSize: 13,
            }}
          >
            {dual ? (
              <>
                {ses.map((se, i) => (
                  <div
                    key={se.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      alignItems: "flex-start",
                    }}
                  >
                    <div
                      style={{
                        color: "var(--text-mute)",
                        fontSize: 11,
                        flexShrink: 0,
                        paddingTop: 2,
                      }}
                    >
                      EID{i + 1}
                    </div>
                    <div
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        wordBreak: "break-all",
                        textAlign: "right",
                      }}
                    >
                      {se.eid || "—"}
                      {se.eid && (
                        <button
                          className="btn btn-ghost"
                          style={{
                            marginLeft: 6,
                            padding: "2px 8px",
                            fontSize: 11,
                          }}
                          onClick={() => copyText(se.eid, showToast)}
                        >
                          Copy
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ color: "var(--text-mute)", fontSize: 11 }}>
                    Storage remaining
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      flexWrap: "wrap",
                      fontWeight: 600,
                    }}
                  >
                    {ses.map((se, i) => (
                      <span key={se.id}>
                        SE{i + 1}: {formatBytes(se.freeSpace)}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ color: "var(--text-mute)", fontSize: 11 }}>
                    EID
                  </div>
                  <div
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      wordBreak: "break-all",
                    }}
                  >
                    {ses[0]?.eid || "—"}
                    {ses[0]?.eid && (
                      <button
                        className="btn btn-ghost"
                        style={{
                          marginLeft: 6,
                          padding: "2px 8px",
                          fontSize: 11,
                        }}
                        onClick={() => copyText(ses[0].eid, showToast)}
                      >
                        Copy
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--text-mute)", fontSize: 11 }}>
                    Default SM-DP+
                  </div>
                  <div>
                    {ses[0]?.defaultDpAddress ||
                      ses[0]?.chip?.defaultDpAddress ||
                      "—"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--text-mute)", fontSize: 11 }}>
                    Free NVM
                  </div>
                  <div>
                    {formatBytes(
                      ses[0]?.freeSpace ?? ses[0]?.chip?.freeNonVolatileMemory,
                    )}
                  </div>
                </div>
              </div>
            )}
            <div>
              <div style={{ color: "var(--text-mute)", fontSize: 11 }}>
                IMEI for download
              </div>
              <div>{imeiDefault || "— (lpac default TAC)"}</div>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <div style={{ fontWeight: 700 }}>Profiles</div>
          <div style={{ fontSize: 12, color: "var(--text-mute)" }}>
            {profiles.length} profile(s)
          </div>
        </div>
        {!profiles.length ? (
          <div style={{ color: "var(--text-mute)", fontSize: 13 }}>
            {loading
              ? "Reading…"
              : !loaded
                ? "Click Load to list profiles."
                : hasEuicc
                  ? "No profiles on this eUICC."
                  : "No profiles to show."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {(dual ? ses : [{ ...ses[0], profiles }]).map((se) => {
              const seProfiles = se.profiles || [];
              if (dual && !seProfiles.length && !se.eid) return null;
              return (
                <div key={se.id || "default"}>
                  {dual && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        marginBottom: 10,
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      <span>
                        {se.label || se.id}:{" "}
                        <span
                          style={{
                            fontFamily: "ui-monospace, monospace",
                            fontWeight: 500,
                            fontSize: 12,
                          }}
                        >
                          {se.eid || "—"}
                        </span>
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text-mute)",
                          fontWeight: 500,
                        }}
                      >
                        {seProfiles.length}
                      </span>
                    </div>
                  )}
                  {!seProfiles.length ? (
                    <div
                      style={{
                        color: "var(--text-mute)",
                        fontSize: 13,
                        marginBottom: dual ? 8 : 0,
                      }}
                    >
                      No profiles on this SE.
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      {seProfiles.map((p: EsimProfile) => {
                        const enabled =
                          String(p.profileState || "").toLowerCase() ===
                          "enabled";
                        const target = seTarget(reader, se);
                        const title = profileDisplayName(p);
                        return (
                          <div
                            key={`${se.id}:${p.iccid}`}
                            style={{
                              border: `1px solid ${enabled ? "color-mix(in srgb, var(--primary) 35%, var(--border))" : "var(--border)"}`,
                              borderRadius: 12,
                              padding: "12px 14px",
                              background: enabled
                                ? "color-mix(in srgb, var(--primary) 6%, var(--panel))"
                                : "transparent",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 12,
                            }}
                          >
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  minWidth: 0,
                                }}
                              >
                                <span
                                  style={{
                                    fontWeight: 700,
                                    fontSize: 14,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {title}
                                </span>
                                <StatePill state={p.profileState} />
                              </div>
                              <div
                                style={{
                                  marginTop: 4,
                                  fontSize: 12,
                                  color: "var(--text-mute)",
                                  fontFamily: "ui-monospace, monospace",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {p.iccid}
                              </div>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                gap: 6,
                                flexShrink: 0,
                                flexWrap: "wrap",
                                justifyContent: "flex-end",
                              }}
                            >
                              {!enabled && (
                                <button
                                  className="btn btn-primary"
                                  disabled={!!busyOp || lineRunning}
                                  onClick={() =>
                                    runProfileOp("Enable", () =>
                                      api.esimEnable(p.iccid, target),
                                    )
                                  }
                                >
                                  Enable
                                </button>
                              )}
                              {enabled && (
                                <button
                                  className="btn btn-ghost"
                                  disabled={!!busyOp || lineRunning}
                                  onClick={() =>
                                    runProfileOp("Disable", () =>
                                      api.esimDisable(p.iccid, target),
                                    )
                                  }
                                >
                                  Disable
                                </button>
                              )}
                              <button
                                className="btn btn-ghost"
                                disabled={!!busyOp || lineRunning}
                                onClick={() =>
                                  setRenameTarget({ se, profile: p })
                                }
                              >
                                Rename
                              </button>
                              <button
                                className="btn btn-ghost"
                                disabled={!!busyOp || lineRunning}
                                onClick={() => {
                                  if (!confirm(`Delete profile ${p.iccid}?`))
                                    return;
                                  runProfileOp("Delete", () =>
                                    api.esimDelete(p.iccid, target),
                                  );
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <div style={{ fontWeight: 700 }}>Notifications</div>
          <button
            className="btn btn-ghost"
            disabled={!!busyOp || lineRunning || !notifications.length}
            onClick={() =>
              runProfileOp("Process notifications", async () => {
                for (const se of ses) {
                  if (!(se.notifications || []).length) continue;
                  await api.esimNotificationsProcess(seTarget(reader, se));
                }
              })
            }
          >
            Process all
          </button>
        </div>
        {!notifications.length ? (
          <div style={{ color: "var(--text-mute)", fontSize: 13 }}>
            {loading
              ? "Reading…"
              : !loaded
                ? "Click Load to list notifications."
                : hasEuicc
                  ? "No pending notifications."
                  : "No notifications to show."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {(dual ? ses : [{ ...ses[0], notifications }]).map((se) => {
              const notes = se.notifications || [];
              if (dual && !notes.length) return null;
              return (
                <div key={`n-${se.id || "default"}`}>
                  {dual && (
                    <div
                      style={{ marginBottom: 8, fontSize: 13, fontWeight: 700 }}
                    >
                      {se.label || se.id}:{" "}
                      <span
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          fontWeight: 500,
                          fontSize: 12,
                        }}
                      >
                        {se.eid || "—"}
                      </span>
                    </div>
                  )}
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    {notes.map((n: EsimNotification) => {
                      const seq = n.seqNumber ?? n.seq;
                      const target = { ...seTarget(reader, se), seq };
                      return (
                        <div
                          key={`${se.id}:${seq}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                            alignItems: "center",
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            padding: "8px 10px",
                            fontSize: 13,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              #{seq} ·{" "}
                              {n.profileManagementOperation ||
                                n.operation ||
                                "notify"}
                            </div>
                            <div
                              style={{ color: "var(--text-dim)", fontSize: 12 }}
                            >
                              {n.iccid || "—"} ·{" "}
                              {n.notificationAddress || n.address || ""}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              className="btn btn-ghost"
                              disabled={!!busyOp || lineRunning}
                              onClick={() =>
                                runProfileOp("Process", () =>
                                  api.esimNotificationsProcess(target),
                                )
                              }
                            >
                              Send
                            </button>
                            <button
                              className="btn btn-ghost"
                              disabled={!!busyOp || lineRunning || seq == null}
                              onClick={() =>
                                seq != null &&
                                runProfileOp("Remove", () =>
                                  api.esimNotificationRemove(
                                    seq,
                                    seTarget(reader, se),
                                  ),
                                )
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showDl && (
        <DownloadModal
          reader={reader}
          ses={ses}
          imeiDefault={imeiDefault}
          showToast={showToast}
          onClose={() => setShowDl(false)}
          onStarted={() =>
            setDl({ step: "started", event: "started", done: false })
          }
        />
      )}

      {renameTarget && (
        <RenameModal
          profile={renameTarget.profile}
          busy={busyOp === "Nickname"}
          onClose={() => setRenameTarget(null)}
          onSave={(nick) => {
            const { se, profile } = renameTarget;
            const target = seTarget(reader, se);
            runProfileOp("Nickname", () =>
              api
                .esimNickname(profile.iccid, nick, target)
                .then(() => setRenameTarget(null)),
            );
          }}
        />
      )}
    </div>
  );
}
