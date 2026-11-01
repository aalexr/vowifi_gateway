import React, { useState } from "react";
import { api } from "../api";
import ProvisionModal from "../components/dashboard/ProvisionModal";
import SipInfoModal from "../components/dashboard/SipInfoModal";
import { Plug } from "lucide-react";
import StateBadge from "../components/dashboard/StateBadge";
import Pipeline from "../components/dashboard/Pipeline";
import { buildReaders, readerTitle } from "../components/dashboard/utils";
import UnprovisionedCard from "../components/dashboard/UnprovisionedCard";
import StartPinModal from "../components/dashboard/StartPinModal";
import { CommonViewProps } from "./common-view-props";

export default function Dashboard({
  instances,
  cards = [],
  noReaders,
  cardsKnown,
  refresh,
  setSelected,
  selected,
  setView,
  showToast,
}: CommonViewProps) {
  const [busy, setBusy] = useState(null);
  const [provision, setProvision] = useState(null);
  const [sipInfo, setSipInfo] = useState(null);
  const [pinPrompt, setPinPrompt] = useState(null); // {inst, tries, error} when a start needs a PIN

  // A start/reprovision may be refused (409) because the card needs a PIN we don't have
  // (deleted, or the saved one is now wrong). Surface that as a PIN prompt instead of an
  // opaque error; anything else is shown as an alert.
  const pinError = (e) => {
    const code = e?.data?.detail?.code;
    return code === "pin_required" || code === "pin_invalid"
      ? { code, tries: e.data.detail.tries }
      : null;
  };

  const act = async (id, fn) => {
    setBusy(id);
    try {
      await fn();
      await refresh();
    } catch (e) {
      const pe = pinError(e);
      if (pe)
        setPinPrompt({
          inst: instances.find((i) => String(i.id) === String(id)),
          tries: pe.tries,
          error:
            pe.code === "pin_invalid"
              ? "Saved PIN was wrong — enter it again."
              : "",
        });
      else alert(e.message);
    }
    setBusy(null);
  };

  const rows = buildReaders(cards, instances);

  // Nothing known yet (first /api/cards still in flight) — render nothing instead of
  // flashing a wrong "no readers" message.
  if (!cardsKnown && rows.length === 0) {
    return (
      <div style={{ color: "var(--text-mute)", fontSize: 13 }}>
        Detecting card readers…
      </div>
    );
  }

  return (
    <div>
      {/* No PC/SC reader connected at all — friendly hint; the reader monitor updates
          this live, so the banner disappears the moment a reader is plugged in. */}
      {noReaders && (
        <div
          className="card"
          style={{
            padding: "32px 28px",
            textAlign: "center",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              color: "var(--text-mute)",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <Plug size={36} strokeWidth={1.5} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10 }}>
            No PC/SC smart-card reader found
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-mute)",
              marginTop: 8,
              lineHeight: 1.6,
              maxWidth: 520,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            Connect a USB smart-card reader with your SIM inserted — it is
            detected automatically and this page updates in real time.
            Softphone, Messages and SIM Config are disabled until a reader is
            present.
          </div>
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))",
          gap: 16,
        }}
      >
        {!noReaders && rows.length === 0 && (
          <div
            className="card"
            style={{ padding: 24, color: "var(--text-dim)" }}
          >
            No card readers detected. Plug in a PC/SC reader and insert a SIM.
          </div>
        )}
        {rows.map((r) => {
          const inst = r.instance;
          const isSel = inst && selected?.id === inst.id;
          const d = inst?.status?.detail || {};
          const clickable = !!inst;
          return (
            <div
              key={`rdr-${r.name || r.index}`}
              className="card"
              onClick={() => clickable && setSelected(inst.id)}
              style={{
                padding: 20,
                cursor: clickable ? "pointer" : "default",
                outline: isSel
                  ? "2px solid var(--primary)"
                  : "1px solid transparent",
                outlineOffset: 2,
              }}
            >
              {/* ---- Header: reader as the identity ---- */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "start",
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span style={{ fontSize: 15, fontWeight: 700 }}>
                      {readerTitle(r)}
                    </span>
                    {isSel && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: "var(--primary)",
                          border: "1px solid var(--primary)",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-mute)",
                      marginTop: 3,
                    }}
                  >
                    {inst
                      ? inst.name || `Line ${inst.id}`
                      : r.present
                        ? "Unprovisioned SIM"
                        : "Empty"}
                  </div>
                </div>
                {inst ? (
                  <StateBadge st={inst.status} />
                ) : (
                  <span className={`pill${r.present ? " pill-warn" : ""}`}>
                    <span
                      className={`dot st-${r.present ? "REGISTERING" : "NO_CARD"}`}
                    />
                    {r.present ? "SIM detected" : "No SIM card"}
                  </span>
                )}
              </div>

              {/* ---- Provisioned line: pipeline + reason + details ---- */}
              {inst && (
                <>
                  <Pipeline st={inst.status} />
                  {inst.status?.state !== "OK" &&
                    inst.status?.state !== "STOPPED" &&
                    inst.status?.reason && (
                      <div
                        className={`banner ${inst.status.state === "ERROR" ? "banner-danger" : "banner-warn"}`}
                        style={{ marginTop: 12, fontSize: 12.5 }}
                      >
                        {inst.status.reason}
                        {inst.status.retry &&
                          inst.status.retry.count > 0 &&
                          inst.status.state !== "ERROR" && (
                            <span style={{ color: "var(--text-mute)" }}>
                              {" "}
                              · attempt {inst.status.retry.count}/
                              {inst.status.retry.max}
                            </span>
                          )}
                        {inst.status.state === "ERROR" && setView && (
                          <span>
                            {" "}
                            ·{" "}
                            <a
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelected(inst.id);
                                setView("logs");
                              }}
                              style={{
                                cursor: "pointer",
                                textDecoration: "underline",
                              }}
                            >
                              view logs
                            </a>
                          </span>
                        )}
                      </div>
                    )}
                  <div
                    style={{
                      marginTop: 16,
                      fontSize: 13,
                      display: "grid",
                      gridTemplateColumns: "auto 1fr",
                      gap: "6px 12px",
                      color: "var(--text-soft)",
                    }}
                  >
                    <span style={{ color: "var(--text-mute)" }}>Carrier</span>
                    <span>{`${inst.mcc}-${inst.mnc}`}</span>
                    <span style={{ color: "var(--text-mute)" }}>Number</span>
                    <span className="mono">
                      {d.msisdn || inst.msisdn || "—"}
                    </span>
                    <span style={{ color: "var(--text-mute)" }}>IMSI</span>
                    <span className="mono" style={{ fontSize: 11 }}>
                      {inst.imsi || "—"}
                    </span>
                    <span style={{ color: "var(--text-mute)" }}>ICCID</span>
                    <span className="mono" style={{ fontSize: 11 }}>
                      {r.card?.iccid || inst.iccid || "—"}
                    </span>
                    <span style={{ color: "var(--text-mute)" }}>SMSC</span>
                    <span className="mono">{d.smsc || inst.smsc || "—"}</span>
                    <span style={{ color: "var(--text-mute)" }}>P-CSCF</span>
                    <span className="mono" style={{ fontSize: 11 }}>
                      {d.pcscf || "—"}
                    </span>
                    <span style={{ color: "var(--text-mute)" }}>IMS reg</span>
                    <span>{d.registration || "—"}</span>
                    <span style={{ color: "var(--text-mute)" }}>PIN</span>
                    <span>
                      {d.pin?.state || "—"}
                      {d.pin?.tries_left != null
                        ? ` (${d.pin.tries_left} tries)`
                        : ""}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 18,
                      flexWrap: "wrap",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {inst.status?.state === "STOPPED" ? (
                      <button
                        className="btn btn-primary"
                        disabled={busy === inst.id}
                        onClick={() => act(inst.id, () => api.start(inst.id))}
                      >
                        Start
                      </button>
                    ) : inst.status?.state === "ERROR" ? (
                      <button
                        className="btn btn-primary"
                        disabled={busy === inst.id}
                        onClick={() =>
                          act(inst.id, () => api.reprovision(inst.id))
                        }
                      >
                        Re-provision
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost"
                        disabled={busy === inst.id}
                        onClick={() => act(inst.id, () => api.stop(inst.id))}
                      >
                        Stop
                      </button>
                    )}
                    {inst.status?.state !== "STOPPED" &&
                      inst.status?.state !== "ERROR" && (
                        <button
                          className="btn btn-ghost"
                          disabled={busy === inst.id}
                          onClick={() =>
                            act(inst.id, () => api.register(inst.id))
                          }
                        >
                          Re-register
                        </button>
                      )}
                    {inst.status?.state !== "STOPPED" &&
                      inst.status?.state !== "ERROR" && (
                        <button
                          className="btn btn-ghost"
                          disabled={busy === inst.id}
                          onClick={() =>
                            act(inst.id, () => api.reprovision(inst.id))
                          }
                        >
                          Re-provision
                        </button>
                      )}
                    <button
                      className="btn btn-ghost"
                      onClick={() => setSipInfo(inst)}
                    >
                      SIP info
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setSelected(inst.id);
                        setView && setView("sims");
                      }}
                    >
                      Configure ▸
                    </button>
                  </div>
                </>
              )}

              {/* ---- Unprovisioned card in this reader (PIN-gated flow) ---- */}
              {!inst && r.present && (
                <UnprovisionedCard
                  card={r.card}
                  refresh={refresh}
                  onProvision={(pin) => setProvision({ card: r.card, pin })}
                />
              )}

              {/* ---- Empty reader ---- */}
              {!inst && !r.present && (
                <div
                  style={{
                    marginTop: 14,
                    fontSize: 13,
                    color: "var(--text-mute)",
                  }}
                >
                  No SIM card inserted in this reader.
                </div>
              )}
            </div>
          );
        })}
      </div>
      {provision && (
        <ProvisionModal
          card={provision.card}
          pin={provision.pin}
          onClose={() => setProvision(null)}
          onDone={refresh}
        />
      )}
      {sipInfo && (
        <SipInfoModal
          instance={sipInfo}
          onClose={() => setSipInfo(null)}
          setView={setView}
          setSelected={setSelected}
        />
      )}
      {pinPrompt && (
        <StartPinModal
          inst={pinPrompt.inst}
          tries={pinPrompt.tries}
          error={pinPrompt.error}
          onClose={() => setPinPrompt(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}
