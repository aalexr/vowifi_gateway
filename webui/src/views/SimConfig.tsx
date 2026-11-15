import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  api,
  asApiError,
  type CardInfo,
  type InstanceConfig,
  type InstanceId,
  type SipConfig,
  type SipExternalAccount,
} from "../api";
import SimSelector from "../components/common/SimSelector";
import {
  emptyInstance,
  sipUsernameConflict,
} from "../components/simconfig/utils";
import SimCardPanel from "../components/simconfig/SimCardPanel";
import LineHeader from "../components/simconfig/LineHeader";
import LineSection from "../components/simconfig/LineSection";
import SubscriberSection from "../components/simconfig/SubscriberSection";
import EpdgTunnelSection from "../components/simconfig/EpdgTunnelSection";
import LocalSipSection from "../components/simconfig/LocalSipSection";
import ImsRegistrationSection from "../components/simconfig/ImsRegistrationSection";
import PaniSection from "../components/simconfig/PaniSection";
import CarrierCodecsSection from "../components/simconfig/CarrierCodecsSection";
import StatusMessage, {
  status,
  type Status,
} from "../components/simconfig/StatusMessage";
import type { SmscMode } from "../components/simconfig/SmscField";
import type { InstanceForm } from "../components/simconfig/types";
import { cardFacts, pinTries } from "../components/simconfig/pin";
import type { CommonViewProps } from "./common-view-props";

type SimConfigProps = Pick<
  CommonViewProps,
  "instances" | "selected" | "refresh" | "cards" | "setSelected"
>;

/** The saved line as an editable form (sip deep-merged so new knobs keep their defaults). */
const formFor = (inst: InstanceConfig): InstanceForm => {
  const base = emptyInstance();
  return { ...base, ...inst, sip: { ...base.sip, ...(inst.sip || {}) } };
};

/**
 * Where the line's SMSC comes from. Saved with the line since the mode was added; for lines
 * saved before that, a stored SMSC that differs from the SIM's own (EF_SMSP, from the card
 * monitor) was typed by hand, so it must not be overwritten by the next card read.
 */
const smscModeFor = (inst: InstanceConfig, simSmsc?: string | null): SmscMode => {
  if (inst.smsc_mode === "manual" || inst.smsc_mode === "auto")
    return inst.smsc_mode;
  if (inst.smsc && simSmsc && inst.smsc !== simSmsc) return "manual";
  if (inst.smsc && !simSmsc) return "manual"; // can't confirm it came from the SIM: keep it
  return "auto";
};

/** Comparable snapshot of what Save would persist (runtime-only fields left out). */
const snapshot = (f: InstanceForm, mode: SmscMode, pin: string) => {
  const rest: Partial<InstanceForm> = { ...f };
  delete rest.status;
  delete rest.has_pin;
  return JSON.stringify({ ...rest, smsc_mode: mode, pin });
};

const isRunning = (inst?: InstanceConfig | null) =>
  !!inst?.status && inst.status.state !== "STOPPED";

export default function SimConfig({
  instances,
  selected,
  refresh,
  cards,
  setSelected,
}: SimConfigProps) {
  const navigate = useNavigate();
  const [readers, setReaders] = useState<string[]>([]);
  const [card, setCard] = useState<CardInfo | null>(null); // last "Detect card" result
  const [pin, setPin] = useState("");
  const [pinMsg, setPinMsg] = useState<Status | null>(null); // detect / PIN feedback (SIM card panel)
  const [saveMsg, setSaveMsg] = useState<Status | null>(null); // save feedback (action bar)
  const [form, setForm] = useState<InstanceForm>(emptyInstance());
  const [smscMode, setSmscMode] = useState<SmscMode>("auto"); // 'auto' = read from SIM, 'manual' = typed
  const [baseline, setBaseline] = useState(""); // snapshot of the line as last loaded/saved
  const [busy, setBusy] = useState(false); // save / restart / delete / card I/O in flight
  const [needsRestart, setNeedsRestart] = useState(false); // saved while the engine was running

  // The card monitor's entry for the SIM this line is bound to (by matched id or ICCID).
  const liveCardFor = (inst?: InstanceConfig | null) =>
    inst
      ? cards.find(
          (c) =>
            c.present &&
            (c.matched === inst.id || (!!c.iccid && c.iccid === inst.iccid)),
        )
      : undefined;

  // Refresh the physical-reader list whenever the detected-card set changes (hotplug), so
  // the reader picker never lists a reader that has been unplugged.
  useEffect(() => {
    api
      .readers()
      .then((r) => setReaders(r.readers))
      .catch(() => {});
  }, [cards.map((c) => c.name).join(",")]);

  // Load a line: everything on the page belongs to it, so the previous line's card readout,
  // typed PIN and messages go too (they would otherwise describe the wrong SIM).
  const load = (inst: InstanceConfig) => {
    const f = formFor(inst);
    const mode = smscModeFor(inst, liveCardFor(inst)?.smsc);
    setForm(f);
    setSmscMode(mode);
    setBaseline(snapshot(f, mode, ""));
    setCard(null);
    setPin("");
    setPinMsg(null);
    setSaveMsg(null);
    setNeedsRestart(false);
  };
  useEffect(() => {
    if (selected) load(selected);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!baseline && snapshot(form, smscMode, pin) !== baseline;

  // A line saved before `smsc_mode` existed derives its mode from the SIM's own SMSC, which
  // the card monitor may deliver after the line loaded: settle it then, unless edited.
  const simSmsc = liveCardFor(selected)?.smsc;
  useEffect(() => {
    if (!selected || selected.smsc_mode || !simSmsc || dirty) return;
    const mode = smscModeFor(selected, simSmsc);
    if (mode === smscMode) return;
    setSmscMode(mode);
    setBaseline(snapshot(form, mode, pin));
  }, [selected?.id, simSmsc]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Leaving the page (reload / close) with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

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

  const facts = cardFacts(readerIdx(), card, cards);
  const tries = pinTries(facts, selected?.status);

  const switchLine = (id: InstanceId | null) => {
    if (id === selected?.id) return;
    if (
      dirty &&
      !confirm(
        `Discard unsaved changes to ${form.name || `line ${form.id}`}?`,
      )
    )
      return;
    setSelected(id);
  };

  const revert = () => {
    if (selected) load(selected);
  };

  const detect = async () => {
    setBusy(true);
    setPinMsg(status("Reading card…"));
    try {
      const c = await api.detect(readerIdx());
      setCard(c);
      if (!c.present) {
        setPinMsg(status("No SIM card in this reader.", "error"));
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
          ? status("Card read into the form.", "ok")
          : status("Card present but locked; enter the PIN to read the IMSI."),
      );
    } catch (e) {
      setPinMsg(status(asApiError(e).message, "error"));
    } finally {
      setBusy(false);
    }
  };

  const verifyPin = async () => {
    setBusy(true);
    setPinMsg(status("Verifying…"));
    try {
      const r = await api.verifyPin(pin, readerIdx());
      if (!r.ok) {
        // Keep the panel's attempt count current, so the guard tightens on the next try.
        if (r.tries != null)
          setCard((c) =>
            c && c.reader_index === readerIdx()
              ? { ...c, pin_tries: r.tries }
              : {
                  reader: readers[readerIdx()] || "",
                  reader_index: readerIdx(),
                  present: true,
                  ...(facts || {}),
                  pin_tries: r.tries,
                },
          );
        setPin("");
        setPinMsg(
          status(
            `PIN rejected: ${r.error}${r.tries != null ? ` (${r.tries} ${r.tries === 1 ? "try" : "tries"} left)` : ""}`,
            "error",
          ),
        );
        return;
      }
      setPinMsg(status("PIN OK. Save to keep it with the line.", "ok"));
      if (r.card?.smsc && smscMode === "auto") upd({ smsc: r.card.smsc }); // now-readable SMSC
    } catch (e) {
      setPinMsg(status(asApiError(e).message, "error"));
      return;
    } finally {
      setBusy(false);
    }
    await detect();
  };

  /** Persist the form: false (error shown) when it didn't save, "restart" when the engine was
   *  running and keeps its old config until restarted. */
  const persist = async (): Promise<boolean | "restart"> => {
    setSaveMsg(null);
    try {
      const sipError = sipUsernameConflict(form.sip);
      if (sipError) throw new Error(sipError);
      const body: Record<string, any> = {
        ...form,
        mnc: String(form.mnc).padStart(3, "0"),
        smsc_mode: smscMode,
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
      setBaseline(snapshot(form, smscMode, ""));
      setPin("");
      await refresh();
      return res?.restart_required ? "restart" : true;
    } catch (err) {
      setSaveMsg(status(asApiError(err).message, "error"));
      return false;
    }
  };

  const confirmRestart = () =>
    selected?.status?.state !== "OK" ||
    confirm(
      `Restart ${form.name || `line ${form.id}`}? It is registered now; it leaves IMS ` +
        "while the engine is recreated, and calls in progress end.",
    );

  const restart = async () => {
    setSaveMsg(status("Restarting the line…"));
    try {
      await api.reprovision(form.id);
      await refresh();
      setNeedsRestart(false);
      setSaveMsg(status("Saved and restarted with the new config.", "ok"));
    } catch (e) {
      setNeedsRestart(true);
      setSaveMsg(
        status(`Saved, but the restart failed: ${asApiError(e).message}`, "error"),
      );
    }
  };

  const save = async (andRestart: boolean) => {
    if (andRestart && !confirmRestart()) return;
    setBusy(true);
    const r = await persist();
    if (r === "restart") {
      if (andRestart) await restart();
      else {
        setNeedsRestart(true);
        setSaveMsg(
          status("Saved. The running line keeps its old config until restarted.", "ok"),
        );
      }
    } else if (r) setSaveMsg(status("Saved.", "ok"));
    setBusy(false);
  };

  const restartNow = async () => {
    if (!confirmRestart()) return;
    setBusy(true);
    await restart();
    setBusy(false);
  };

  const del = async () => {
    const name = form.name || `line ${form.id}`;
    const warn = [
      isRunning(selected) && "Its engine is stopped now.",
      form.has_pin && "The saved PIN goes with it.",
    ]
      .filter(Boolean)
      .join(" ");
    if (!confirm(`Delete ${name}?${warn ? `\n\n${warn}` : ""}`)) return;
    setBusy(true);
    try {
      await api.deleteInstance(form.id);
      setBaseline("");
      await refresh();
      const next = instances.find((i) => i.id !== form.id);
      setSelected(next ? next.id : null);
      if (!next) setForm(emptyInstance());
    } catch (e) {
      setSaveMsg(status(`Not deleted: ${asApiError(e).message}`, "error"));
    } finally {
      setBusy(false);
    }
  };

  const deleteSavedPin = async () => {
    if (!form.id) return;
    if (
      !confirm(
        "Forget the saved SIM PIN for this line?\n\nThe line is stopped and, " +
          "the next time you start it, asks for the PIN again.",
      )
    )
      return;
    setBusy(true);
    try {
      const r = await api.clearPin(form.id);
      upd({ has_pin: false }); // reflect immediately (form is local state)
      await refresh();
      setPinMsg(
        r.had_pin
          ? status("Saved PIN forgotten; the line asks for it on next start.", "ok")
          : status("No saved PIN to forget."),
      );
    } catch (e) {
      setPinMsg(status(asApiError(e).message, "error"));
    } finally {
      setBusy(false);
    }
  };

  const onSmscModeChange = (mode: SmscMode) => {
    setSmscMode(mode);
    const simSmsc = card?.smsc || liveCardFor(selected)?.smsc;
    if (mode === "auto" && simSmsc) upd({ smsc: simSmsc });
  };

  const readerLabel = useMemo(() => {
    const c = liveCardFor(selected);
    return c ? `Reader ${c.index}` : "No reader";
  }, [selected?.id, selected?.iccid, cards]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = isRunning(selected);
  const canSave = !busy && !!form.id && !!form.imsi;
  const isSaved = !!selected && selected.id === form.id;

  return (
    <div className="simcfg">
      {instances.length > 1 && (
        <SimSelector
          instances={instances}
          cards={cards}
          selected={selected}
          setSelected={switchLine}
          label="Configuring line"
          includeAbsent
        />
      )}
      {isSaved && selected && (
        <LineHeader
          line={selected}
          readerLabel={readerLabel}
          onViewLogs={() => navigate("/logs")}
        />
      )}
      <div className="simcfg-grid">
        <SimCardPanel
          form={form}
          upd={upd}
          readers={readers}
          readerIdx={readerIdx()}
          portForIdx={portForIdx}
          facts={facts}
          tries={tries}
          lineStatus={isSaved ? selected?.status : null}
          pin={pin}
          setPin={setPin}
          busy={busy}
          onDetect={detect}
          onVerifyPin={verifyPin}
          onDeleteSavedPin={deleteSavedPin}
          message={pinMsg}
        />

        <div className="simcfg-form">
          <LineSection
            form={form}
            upd={upd}
            saved={isSaved}
            busy={busy}
            onDelete={del}
          />
          <SubscriberSection
            form={form}
            upd={upd}
            smscMode={smscMode}
            onSmscModeChange={onSmscModeChange}
          />
          <EpdgTunnelSection form={form} upd={upd} />
          <LocalSipSection
            form={form}
            updSip={updSip}
            allowLanListen={!!selected?.status}
          />
          {/* Advanced: collapsed unless the saved line already uses them. */}
          <ImsRegistrationSection form={form} upd={upd} saved={selected} />
          <CarrierCodecsSection id={form.id} />
          <PaniSection form={form} updSip={updSip} saved={selected} />

          <div
            className="card simcfg-actions"
            role="region"
            aria-label="Save changes"
          >
            {running && isSaved ? (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => save(true)}
                  disabled={!canSave || !dirty}
                >
                  Save &amp; restart line
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => save(false)}
                  disabled={!canSave || !dirty}
                >
                  Save only
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => save(false)}
                disabled={!canSave || (isSaved && !dirty)}
              >
                Save
              </button>
            )}
            {dirty && (
              <button
                className="btn btn-ghost"
                onClick={revert}
                disabled={busy}
              >
                Revert
              </button>
            )}
            <div className="simcfg-actions-msg" aria-live="polite">
              {saveMsg?.tone === "error" || (!dirty && saveMsg) ? (
                <StatusMessage
                  message={saveMsg}
                  className="simcfg-msg-inline"
                />
              ) : dirty ? (
                <span className="simcfg-dirty">Unsaved changes</span>
              ) : null}
              {!dirty && needsRestart && running && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={restartNow}
                  disabled={busy}
                >
                  Restart now
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
