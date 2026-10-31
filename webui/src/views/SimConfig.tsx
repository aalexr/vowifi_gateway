import React, { useEffect, useState } from "react";
import { api } from "../api";
import SimSelector from "../components/common/SimSelector";
import {
  PANI_ACCESS_TYPES,
  emptyInstance,
  previewPani,
  sipUsernameConflict,
} from "../components/simconfig/utils";
import Field from "../components/simconfig/Field";

export default function SimConfig({
  instances,
  selected,
  refresh,
  cards,
  setSelected,
}) {
  const [readers, setReaders] = useState([]);
  const [card, setCard] = useState(null);
  const [pin, setPin] = useState("");
  const [pinMsg, setPinMsg] = useState("");
  const [form, setForm] = useState(emptyInstance());
  const [saving, setSaving] = useState(false);
  const [smscMode, setSmscMode] = useState("auto"); // 'auto' = read from SIM, 'manual' = typed

  // Refresh the physical-reader list whenever the detected-card set changes (hotplug), so
  // the reader picker never lists a reader that has been unplugged.
  useEffect(() => {
    api
      .readers()
      .then((r) => setReaders(r.readers))
      .catch(() => {});
  }, [cards.map((c) => c.name).join(",")]);
  useEffect(() => {
    if (!selected) return;
    // Deep-merge sip so new PANI knobs keep their defaults when an older saved
    // instance has no pani_* keys yet (shallow spread would drop emptyInstance.sip).
    const base = emptyInstance();
    setForm({
      ...base,
      ...selected,
      sip: { ...base.sip, ...(selected.sip || {}) },
    });
  }, [selected?.id]);
  // Keep the reader selection valid for the CURRENT hardware. A stored reader_index can be
  // stale — saved when more readers were attached — and point past the live reader list; the
  // <select> then has no matching option and "Detect card" probes a phantom reader ("No SIM
  // card in reader N"). Clamp any out-of-range index back onto a reader that actually exists.
  useEffect(() => {
    if (!readers.length) return;
    setForm((f) =>
      f.reader_index >= readers.length || f.reader_index < 0
        ? { ...f, reader_index: 0 }
        : f,
    );
  }, [readers.length]);
  // Keep the "PIN saved?" indicator in sync when it changes server-side (delete-PIN,
  // start-with-PIN) without a full line switch — mirror the fresh value onto the form.
  useEffect(() => {
    if (selected) setForm((f) => ({ ...f, has_pin: selected.has_pin }));
  }, [selected?.has_pin]);

  const upd = (patch) => setForm((f) => ({ ...f, ...patch }));
  const updSip = (patch) =>
    setForm((f) => ({ ...f, sip: { ...f.sip, ...patch } }));
  // The reader index to act on, clamped to a reader that currently exists (never probe a
  // stale/out-of-range index that would report a phantom empty reader).
  const readerIdx = () =>
    form.reader_index >= 0 && form.reader_index < readers.length
      ? form.reader_index
      : 0;
  // Stable USB port path of a reader index (from the live card monitor). A line binds to this
  // port, not the enumeration index, so it sticks to the physical reader socket even when pcscd
  // re-enumerates two identical readers in a different order.
  const portForIdx = (i) =>
    (cards.find((c) => c.index === i) || {}).reader_port || "";

  const detect = async () => {
    setPinMsg("Detecting…");
    try {
      const c = await api.detect(readerIdx());
      setCard(c);
      if (!c.present) {
        setPinMsg("No SIM card in this reader.");
        return;
      }
      const patch: Record<string, any> = {
        imsi: c.imsi || form.imsi,
        mcc: c.mcc || form.mcc,
        mnc: c.mnc || form.mnc,
      };
      if (c.smsc && smscMode === "auto") patch.smsc = c.smsc; // SMSC from the SIM (EF_SMSP)
      if (c.imsi) patch.reader = `imsi:${c.imsi}`;
      // Bind the line to the reader's stable physical USB port (from the detected card, else the
      // live monitor). Persisted so start-time re-resolves the correct index for this socket.
      const port = c.reader_port || portForIdx(readerIdx());
      if (port) patch.reader_port = port;
      if (!form.id) patch.id = String(instances.length + 1);
      upd(patch);
      setPinMsg(
        c.imsi
          ? "Card read."
          : `Card present (enter PIN to read IMSI). ICCID ${c.iccid || "?"}, tries ${c.pin_tries ?? "?"}`,
      );
    } catch (e) {
      setPinMsg("Error: " + e.message);
    }
  };

  const verifyPin = async () => {
    setPinMsg("Verifying…");
    try {
      const r = await api.verifyPin(pin, readerIdx());
      setPinMsg(
        r.ok ? "PIN OK ✓" : `Failed: ${r.error} (${r.tries} tries left)`,
      );
      if (r.ok) {
        const p: Record<string, any> = { pin };
        if (r.card?.smsc && smscMode === "auto") p.smsc = r.card.smsc; // now-readable SMSC from SIM
        upd(p);
        await detect();
      }
    } catch (e) {
      setPinMsg("Error: " + e.message);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const sipError = sipUsernameConflict(form.sip);
      if (sipError) throw new Error(sipError);
      const body: Record<string, any> = {
        ...form,
        mnc: String(form.mnc).padStart(3, "0"),
      };
      // Strip runtime-only fields that ride along on the instance object from /api/instances
      // (they are computed per-request, not config — never persist them).
      delete body.status;
      delete body.has_pin;
      // Never send an empty PIN — the stored PIN (tied to this IMSI) must survive edits to
      // unrelated fields. `pin` state is only set when the user re-enters/verifies a PIN
      // here; only then do we forward it to update the saved credential.
      delete body.pin;
      if (pin) body.pin = pin;
      // An empty password field means "keep the saved secret", not "replace it with
      // empty". A deliberate password change is sent normally.
      if (body.sip) {
        body.sip = {
          ...body.sip,
          external: (body.sip.external || []).map((account) => {
            const row: { username: string; password?: string } = {
              username: account.username || "",
            };
            if (String(account.password || "").trim())
              row.password = account.password;
            return row;
          }),
        };
      }
      const res = await api.saveInstance(body);
      await refresh();
      if (res?.restart_required) {
        const message =
          "Saved. Restart this line (Stop → Start) for SIP, IMEI, and softphone changes to take effect.";
        setPinMsg(message);
        alert(message);
      } else {
        setPinMsg("Saved.");
      }
    } catch (e) {
      setPinMsg(e.message);
      alert(e.message);
    }
    setSaving(false);
  };

  const del = async () => {
    if (!confirm("Delete this instance?")) return;
    await api.deleteInstance(form.id);
    await refresh();
    setForm(emptyInstance());
  };

  const deleteSavedPin = async () => {
    if (!form.id) return;
    if (
      !confirm(
        "Delete the saved SIM PIN for this line?\n\nThe line will be stopped and, " +
          "the next time you start it, you'll be asked to enter the PIN again.",
      )
    )
      return;
    try {
      const r = await api.clearPin(form.id);
      upd({ has_pin: false }); // reflect immediately (form is local state)
      await refresh();
      setPinMsg(
        r.had_pin
          ? "Saved PIN deleted — the line will ask for it on next start."
          : "No saved PIN to delete.",
      );
    } catch (e) {
      alert(e.message);
    }
  };

  const addAccount = () =>
    updSip({
      external: [...(form.sip.external || []), { username: "", password: "" }],
    });
  const setAccount = (i, k, v) =>
    updSip({
      external: form.sip.external.map((a, idx) =>
        idx === i ? { ...a, [k]: v } : a,
      ),
    });
  const sipUserError = sipUsernameConflict(form.sip);

  return (
    <div style={{ maxWidth: 1000 }}>
      {instances.length > 1 && (
        <SimSelector
          instances={instances}
          cards={cards}
          selected={selected}
          setSelected={setSelected}
          label="Configuring line"
        />
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Card / PIN panel */}
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>SIM card</h3>
          <Field label="Reader">
            <select
              value={form.reader_index}
              onChange={(e) =>
                upd({
                  reader_index: +e.target.value,
                  reader_port: portForIdx(+e.target.value) || form.reader_port,
                })
              }
            >
              {readers.map((r, i) => (
                <option key={i} value={i}>
                  {i}: {r}
                  {portForIdx(i) ? ` — USB ${portForIdx(i)}` : ""}
                </option>
              ))}
              {readers.length === 0 && <option>no readers</option>}
            </select>
          </Field>
          {form.reader_port && (
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 4 }}
            >
              Bound to USB port {form.reader_port} (stable across reader
              re-enumeration)
            </div>
          )}
          <button
            className="btn btn-ghost"
            style={{ marginTop: 10 }}
            onClick={detect}
          >
            Detect card
          </button>
          {card && (
            <div
              className="mono"
              style={{
                fontSize: 12,
                color: card.present ? "var(--text-dim)" : "var(--danger)",
                marginTop: 12,
                lineHeight: 1.6,
              }}
            >
              {card.present ? (
                <>
                  ICCID: {card.iccid || "—"}
                  <br />
                  IMSI: {card.imsi || "(locked)"}
                  <br />
                  {card.reader_port && (
                    <>
                      USB port: {card.reader_port}
                      <br />
                    </>
                  )}
                  PIN:{" "}
                  {card.pin_enabled
                    ? `enabled, ${card.pin_tries} tries`
                    : "disabled"}
                </>
              ) : (
                <>No SIM card in reader {card.reader_index}.</>
              )}
            </div>
          )}
          <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />
          <Field label="PIN (CHV1)">
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="e.g. 123456"
            />
          </Field>
          <div
            style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}
          >
            <button
              className="btn btn-primary"
              onClick={verifyPin}
              disabled={!pin}
            >
              Verify PIN
            </button>
            {form.id && form.has_pin && (
              <button
                className="btn btn-ghost"
                style={{ color: "var(--danger)" }}
                onClick={deleteSavedPin}
              >
                Delete saved PIN
              </button>
            )}
          </div>
          {form.id && (
            <div
              style={{ fontSize: 12, color: "var(--text-mute)", marginTop: 8 }}
            >
              {form.has_pin
                ? "A PIN is saved for this line and used automatically on start."
                : "No PIN saved — you'll be asked for it when the line is started (if the SIM requires one)."}
            </div>
          )}
          {pinMsg && (
            <div
              style={{
                fontSize: 13,
                marginTop: 10,
                color:
                  pinMsg.includes("OK") ||
                  pinMsg.includes("read") ||
                  pinMsg.startsWith("Saved.") ||
                  pinMsg.includes("deleted")
                    ? "var(--ok)"
                    : "var(--warn)",
              }}
            >
              {pinMsg}
            </div>
          )}
        </div>

        {/* Instance form */}
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ marginTop: 0 }}>Line configuration</h3>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
          >
            <Field label="Instance ID">
              <input
                value={form.id}
                onChange={(e) => upd({ id: e.target.value })}
                placeholder="1"
              />
            </Field>
            <Field label="Name">
              <input
                value={form.name}
                onChange={(e) => upd({ name: e.target.value })}
                placeholder="Telus"
              />
            </Field>
            <Field label="IMSI">
              <input
                className="mono"
                value={form.imsi}
                onChange={(e) => upd({ imsi: e.target.value })}
              />
            </Field>
            <Field label="MCC">
              <input
                value={form.mcc}
                onChange={(e) => upd({ mcc: e.target.value })}
              />
            </Field>
            <Field label="MNC">
              <input
                value={form.mnc}
                onChange={(e) => upd({ mnc: e.target.value })}
              />
            </Field>
            <Field label="IMEI">
              <input
                className="mono"
                value={form.imei}
                onChange={(e) => upd({ imei: e.target.value })}
                placeholder="35123456-789012-3"
              />
            </Field>
            <Field label="IMEISV">
              <input
                className="mono"
                value={form.imeisv || ""}
                onChange={(e) =>
                  upd({ imeisv: e.target.value.replace(/[^0-9]/g, "") })
                }
                maxLength={16}
                placeholder="auto from IMEI (DEVICE_IDENTITY)"
              />
            </Field>
            <Field label="Phone number (MSISDN)">
              <input
                className="mono"
                value={form.msisdn}
                onChange={(e) => upd({ msisdn: e.target.value })}
                placeholder="auto-learned"
              />
            </Field>
            <Field label="SMS centre (SMSC)">
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  marginBottom: 6,
                  fontSize: 13,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="scmode"
                    checked={smscMode === "auto"}
                    style={{ width: "auto" }}
                    onChange={() => {
                      setSmscMode("auto");
                      if (card?.smsc) upd({ smsc: card.smsc });
                    }}
                  />
                  Auto (from SIM)
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="scmode"
                    checked={smscMode === "manual"}
                    style={{ width: "auto" }}
                    onChange={() => setSmscMode("manual")}
                  />
                  Manual
                </label>
              </div>
              <input
                className="mono"
                value={form.smsc}
                readOnly={smscMode === "auto"}
                onChange={(e) => upd({ smsc: e.target.value })}
                placeholder={
                  smscMode === "auto"
                    ? "detect card / verify PIN to read from SIM"
                    : "+1..."
                }
                style={smscMode === "auto" ? { opacity: 0.7 } : undefined}
              />
            </Field>
            <Field label="Reader match">
              <input
                className="mono"
                value={form.reader}
                onChange={(e) => upd({ reader: e.target.value })}
                placeholder="imsi:302..."
              />
            </Field>
            <Field label="APN">
              <input
                className="mono"
                value={form.apn ?? "ims"}
                onChange={(e) => upd({ apn: e.target.value })}
                placeholder="ims"
              />
            </Field>
            <Field label="ePDG identity (IDr)">
              <select
                value={form.idr_mode ?? "apn"}
                onChange={(e) => upd({ idr_mode: e.target.value })}
              >
                <option value="apn">Bare APN (default)</option>
                <option value="fqdn">APN-FQDN</option>
              </select>
            </Field>
            <Field label="IMS address family (CP)">
              <select
                value={form.cp_mode ?? "auto"}
                onChange={(e) => upd({ cp_mode: e.target.value })}
              >
                <option value="auto">Auto-detect (recommended)</option>
                <option value="dual">Dual-stack (IPv4+IPv6)</option>
                <option value="v6">IPv6 only</option>
                <option value="v4">IPv4 only</option>
              </select>
              {form.cp_mode &&
                form.cp_mode !== "auto" &&
                form.cp_mode_source === "auto" && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-mute)",
                      marginTop: 2,
                    }}
                  >
                    Auto-detected: {form.cp_mode.toUpperCase()}. Switch back to
                    Auto-detect to re-probe.
                  </div>
                )}
            </Field>
          </div>
          <div
            style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 4 }}
          >
            IDr is how the APN is presented to the ePDG. <b>Bare APN</b> (just
            the APN string) is what most carriers' ePDGs expect and is the safe
            default; <b>APN-FQDN</b> (
            <code>&lt;apn&gt;.apn.epc.mnc…mcc….pub.3gppnetwork.org</code>) is
            required only by a few stricter carriers — some networks reject it.
          </div>
          <div
            style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 4 }}
          >
            <b>IMS address family</b> must match the carrier's IMS PDN.{" "}
            <b>Auto-detect</b> figures it out for you (matches known carriers,
            else probes families after SIM auth) and pins the one that works —
            leave this unless you know the carrier needs a specific family.
            Telus/EE are IPv6; Vodafone UK is IPv4.
          </div>

          <label
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={form.use_reauth_id !== false}
              onChange={(e) => upd({ use_reauth_id: e.target.checked })}
            />
            Use EAP-AKA fast re-authentication
          </label>
          <div
            style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 4 }}
          >
            On by default. After a successful attach the carrier's AAA may hand
            out a short-lived re-authentication identity; presenting it on a
            reconnect lets the network skip a full SIM auth run. If it has
            expired the engine notices the rejection and retries with the
            permanent IMSI identity by itself, so this is safe to leave on. Turn
            it <b>off</b> for a carrier whose AAA rejects it on every reconnect
            (O2 UK) to skip that wasted attach attempt.
          </div>

          <h4 style={{ marginBottom: 6, marginTop: 16 }}>
            IMS registration (advanced)
          </h4>
          <div className="grid2">
            <Field label="Registrar home domain">
              <input
                className="mono"
                value={form.ims_domain || ""}
                onChange={(e) => upd({ ims_domain: e.target.value.trim() })}
                placeholder="auto (ims.mnc….mcc….3gppnetwork.org)"
              />
            </Field>
            <Field label="Geolocation in REGISTER (country)">
              <input
                className="mono"
                value={form.reg_geolocation_country || ""}
                maxLength={2}
                onChange={(e) =>
                  upd({
                    reg_geolocation_country: e.target.value
                      .replace(/[^a-zA-Z]/g, "")
                      .toUpperCase(),
                  })
                }
                placeholder="off (e.g. DE)"
              />
            </Field>
          </div>
          <label
            style={{
              marginTop: 8,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={!!form.reg_srvcc_tags}
              onChange={(e) => upd({ reg_srvcc_tags: e.target.checked })}
            />
            Advertise SRVCC capabilities in REGISTER
          </label>
          <label
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={!!form.reg_imei_urn_spare_zero}
              onChange={(e) =>
                upd({ reg_imei_urn_spare_zero: e.target.checked })
              }
            />
            Send IMEI in +sip.instance with spare digit 0 (RFC 7254)
          </label>
          <label
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={!!form.dial_00_to_plus}
              onChange={(e) => upd({ dial_00_to_plus: e.target.checked })}
            />
            Dial a leading 00 as + (for phones that can't dial "+", e.g. DECT
            handsets)
          </label>
          <label
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={!!form.update_after_prack}
              onChange={(e) => upd({ update_after_prack: e.target.checked })}
            />
            Send the call-setup UPDATE only after the PRACK is answered (fixes
            491 → 500 on outgoing calls)
          </label>
          <div
            style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 4 }}
          >
            Leave these off/empty unless the carrier needs them — they change
            only this line. Some IMS cores accept the REGISTER and then remove
            it within a second (status "The carrier's IMS accepted the
            registration but then removed it again") unless it looks like a
            native phone. <b>MTS RU</b> needs only the Geolocation country (the
            country you are in, e.g. <code>DE</code>); the other options are
            there for carriers that turn out to need them (an iPhone sends all
            of them). Restart the line after changing them.
          </div>

          <h4 style={{ marginBottom: 6 }}>Local SIP access</h4>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
          >
            <Field label="Listen address">
              <select
                value={form.sip.listen_addr}
                onChange={(e) => updSip({ listen_addr: e.target.value })}
              >
                <option value="0.0.0.0">0.0.0.0 (all)</option>
                <option value="127.0.0.1">127.0.0.1 (local)</option>
                {selected?.status && <option value="lan">LAN IP</option>}
              </select>
            </Field>
            <Field label="Transport">
              <select
                value={form.sip.transport}
                onChange={(e) => updSip({ transport: e.target.value })}
              >
                <option value="udp">UDP</option>
                <option value="tcp">TCP</option>
                <option value="tls">TLS</option>
              </select>
            </Field>
          </div>
          <label style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              style={{ width: "auto", marginRight: 8 }}
              checked={!!form.sip.webrtc?.enable}
              onChange={(e) =>
                updSip({
                  webrtc: { ...form.sip.webrtc, enable: e.target.checked },
                })
              }
            />
            Enable browser softphone (WebRTC)
          </label>

          <div style={{ marginTop: 12 }}>
            <label>
              Device User-Agent (identify to the carrier as this device)
            </label>
            <input
              className="mono"
              value={form.sip.user_agent || ""}
              onChange={(e) => updSip({ user_agent: e.target.value })}
              placeholder="iOS/26.6 iPhone"
            />
          </div>

          <h4 style={{ marginBottom: 6, marginTop: 16 }}>
            P-Access-Network-Info
          </h4>
          <div
            style={{ fontSize: 11, color: "var(--text-mute)", marginBottom: 8 }}
          >
            Sent on IMS REGISTER / SIP to identify the Wi-Fi access. Default
            matches real phones:
            <code style={{ marginLeft: 4 }}>
              IEEE-802.11;country=&lt;SIM home country&gt;
            </code>
          </div>
          <Field label="Access type">
            <select
              value={form.sip.pani_access_type || "IEEE-802.11"}
              onChange={(e) => updSip({ pani_access_type: e.target.value })}
            >
              {PANI_ACCESS_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <label
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={form.sip.pani_country_enable !== false}
              onChange={(e) =>
                updSip({ pani_country_enable: e.target.checked })
              }
            />
            Report country code
          </label>
          {form.sip.pani_country_enable !== false && (
            <div style={{ marginTop: 6 }}>
              <input
                className="mono"
                maxLength={2}
                value={form.sip.pani_country || ""}
                onChange={(e) =>
                  updSip({
                    pani_country: e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z]/g, "")
                      .slice(0, 2),
                  })
                }
                placeholder="留空 = 按 SIM 的 MCC 自动推导（如 GB）"
              />
            </div>
          )}
          <label
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={!!form.sip.pani_node_id_enable}
              onChange={(e) =>
                updSip({ pani_node_id_enable: e.target.checked })
              }
            />
            Report Wi-Fi AP BSSID (i-wlan-node-id)
          </label>
          {!!form.sip.pani_node_id_enable && (
            <div style={{ marginTop: 6 }}>
              <input
                className="mono"
                value={form.sip.pani_node_id || ""}
                onChange={(e) => updSip({ pani_node_id: e.target.value })}
                placeholder="000cf1126028"
              />
            </div>
          )}
          <div
            className="mono"
            style={{
              marginTop: 10,
              fontSize: 12,
              padding: "8px 10px",
              background: "var(--bg-elev, rgba(0,0,0,.25))",
              borderRadius: 6,
              color: "var(--text-dim)",
            }}
          >
            Preview: P-Access-Network-Info: {previewPani(form.sip, form.mcc)}
          </div>

          <div style={{ marginTop: 12 }}>
            <label>External SIP accounts</label>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-mute)",
                marginBottom: 6,
              }}
            >
              Each account needs a unique username and cannot reuse an Asterisk
              or WebRTC name.
            </div>
            {(form.sip.external || []).map((a, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <input
                  placeholder="username"
                  value={a.username}
                  onChange={(e) => setAccount(i, "username", e.target.value)}
                />
                <input
                  type="password"
                  placeholder="password"
                  value={a.password}
                  onChange={(e) => setAccount(i, "password", e.target.value)}
                />
              </div>
            ))}
            {sipUserError && (
              <div
                style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 6 }}
                role="alert"
              >
                {sipUserError}
              </div>
            )}
            <button className="btn btn-ghost" onClick={addAccount}>
              + Add account
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || !form.id || !form.imsi}
            >
              Save
            </button>
            {form.id && (
              <button className="btn btn-danger" onClick={del}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
