import React, { useEffect, useState } from "react";
import {
  api,
  asApiError,
  type CardInfo,
  type InstanceConfig,
  type SipConfig,
  type SipExternalAccount,
} from "../api";
import SimSelector from "../components/common/SimSelector";
import {
  emptyInstance,
  sipUsernameConflict,
} from "../components/simconfig/utils";
import SimCardSection from "../components/simconfig/SimCardSection";
import LineConfigSection from "../components/simconfig/LineConfigSection";
import ImsRegistrationSection from "../components/simconfig/ImsRegistrationSection";
import LocalSipSection from "../components/simconfig/LocalSipSection";
import StatusMessage from "../components/simconfig/StatusMessage";
import type { SmscMode } from "../components/simconfig/SmscField";
import type { InstanceForm } from "../components/simconfig/types";
import type { CommonViewProps } from "./common-view-props";

type SimConfigProps = Pick<
  CommonViewProps,
  "instances" | "selected" | "refresh" | "cards" | "setSelected"
>;

export default function SimConfig({
  instances,
  selected,
  refresh,
  cards,
  setSelected,
}: SimConfigProps) {
  const [readers, setReaders] = useState<string[]>([]);
  const [card, setCard] = useState<CardInfo | null>(null);
  const [pin, setPin] = useState("");
  const [pinMsg, setPinMsg] = useState(""); // detect / PIN feedback (SIM card section)
  const [saveMsg, setSaveMsg] = useState(""); // save feedback (action bar)
  const [form, setForm] = useState<InstanceForm>(emptyInstance());
  const [saving, setSaving] = useState(false);
  const [smscMode, setSmscMode] = useState<SmscMode>("auto"); // 'auto' = read from SIM, 'manual' = typed

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
    setForm((f) => {
      const i = f.reader_index ?? 0;
      return i >= readers.length || i < 0 ? { ...f, reader_index: 0 } : f;
    });
  }, [readers.length]);
  // Keep the "PIN saved?" indicator in sync when it changes server-side (delete-PIN,
  // start-with-PIN) without a full line switch — mirror the fresh value onto the form.
  useEffect(() => {
    if (selected) setForm((f) => ({ ...f, has_pin: selected.has_pin }));
  }, [selected?.has_pin]);

  const upd = (patch: Partial<InstanceConfig>) =>
    setForm((f) => ({ ...f, ...patch }));
  const updSip = (patch: Partial<SipConfig>) =>
    setForm((f) => ({ ...f, sip: { ...f.sip, ...patch } }));
  // The reader index to act on, clamped to a reader that currently exists (never probe a
  // stale/out-of-range index that would report a phantom empty reader).
  const readerIdx = (): number => {
    const i = form.reader_index ?? 0;
    return i >= 0 && i < readers.length ? i : 0;
  };
  // Stable USB port path of a reader index (from the live card monitor). A line binds to this
  // port, not the enumeration index, so it sticks to the physical reader socket even when pcscd
  // re-enumerates two identical readers in a different order.
  const portForIdx = (i: number): string =>
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
      const patch: Partial<InstanceConfig> = {
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
      setPinMsg("Error: " + asApiError(e).message);
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
        const p: Partial<InstanceConfig> = { pin };
        if (r.card?.smsc && smscMode === "auto") p.smsc = r.card.smsc; // now-readable SMSC from SIM
        upd(p);
        await detect();
      }
    } catch (e) {
      setPinMsg("Error: " + asApiError(e).message);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg("");
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
          external: (body.sip.external || []).map(
            (account: SipExternalAccount) => {
              const row: { username: string; password?: string } = {
                username: account.username || "",
              };
              if (String(account.password || "").trim())
                row.password = account.password;
              return row;
            },
          ),
        };
      }
      const res = await api.saveInstance(body);
      await refresh();
      if (res?.restart_required) {
        const message =
          "Saved. Restart this line (Stop → Start) for SIP, IMEI, and softphone changes to take effect.";
        setSaveMsg(message);
        alert(message);
      } else {
        setSaveMsg("Saved.");
      }
    } catch (err) {
      const e = asApiError(err);
      setSaveMsg(e.message);
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
      alert(asApiError(e).message);
    }
  };

  const onSmscModeChange = (mode: SmscMode) => {
    setSmscMode(mode);
    if (mode === "auto" && card?.smsc) upd({ smsc: card.smsc });
  };

  return (
    <div>
      {instances.length > 1 && (
        <SimSelector
          instances={instances}
          cards={cards}
          selected={selected}
          setSelected={setSelected}
          label="Configuring line"
        />
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <SimCardSection
          form={form}
          upd={upd}
          readers={readers}
          portForIdx={portForIdx}
          card={card}
          pin={pin}
          setPin={setPin}
          onDetect={detect}
          onVerifyPin={verifyPin}
          onDeleteSavedPin={deleteSavedPin}
          message={pinMsg}
        />
        <LineConfigSection
          form={form}
          upd={upd}
          smscMode={smscMode}
          onSmscModeChange={onSmscModeChange}
        />
        <ImsRegistrationSection form={form} upd={upd} />
        <LocalSipSection
          form={form}
          upd={upd}
          updSip={updSip}
          allowLanListen={!!selected?.status}
        />
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
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
        <StatusMessage message={saveMsg} style={{ marginTop: 0 }} />
      </div>
    </div>
  );
}
