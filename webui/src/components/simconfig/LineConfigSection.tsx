import React from "react";
import CheckboxRow from "./CheckboxRow";
import CollapsibleCard from "./CollapsibleCard";
import Field from "./Field";
import Hint from "./Hint";
import SmscField, { type SmscMode } from "./SmscField";
import type { FormSectionProps } from "./types";

interface LineConfigSectionProps extends FormSectionProps {
  smscMode: SmscMode;
  onSmscModeChange: (mode: SmscMode) => void;
}

/** Line identity (IDs, IMSI/IMEI, SMSC) and SWu tunnel parameters. */
export default function LineConfigSection({
  form,
  upd,
  smscMode,
  onSmscModeChange,
}: LineConfigSectionProps) {
  const summary = [form.name, form.imsi].filter(Boolean).join(" · ");
  return (
    <CollapsibleCard id="line" title="Line Configuration" summary={summary}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
        <SmscField
          value={form.smsc || ""}
          onChange={(smsc) => upd({ smsc })}
          mode={smscMode}
          onModeChange={onSmscModeChange}
        />
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
              <Hint>
                Auto-detected: {form.cp_mode.toUpperCase()}. Switch back to
                Auto-detect to re-probe.
              </Hint>
            )}
        </Field>
      </div>
      <Hint>
        IDr is how the APN is presented to the ePDG. <b>Bare APN</b> (just the
        APN string) is what most carriers' ePDGs expect and is the safe default;{" "}
        <b>APN-FQDN</b> (
        <code>&lt;apn&gt;.apn.epc.mnc…mcc….pub.3gppnetwork.org</code>) is
        required only by a few stricter carriers — some networks reject it.
      </Hint>
      <Hint>
        <b>IMS address family</b> must match the carrier's IMS PDN.{" "}
        <b>Auto-detect</b> figures it out for you (matches known carriers, else
        probes families after SIM auth) and pins the one that works — leave this
        unless you know the carrier needs a specific family. Telus/EE are IPv6;
        Vodafone UK is IPv4.
      </Hint>

      <CheckboxRow
        marginTop={10}
        checked={form.use_reauth_id !== false}
        onChange={(use_reauth_id) => upd({ use_reauth_id })}
      >
        Use EAP-AKA fast re-authentication
      </CheckboxRow>
      <Hint>
        On by default. After a successful attach the carrier's AAA may hand out
        a short-lived re-authentication identity; presenting it on a reconnect
        lets the network skip a full SIM auth run. If it has expired the engine
        notices the rejection and retries with the permanent IMSI identity by
        itself, so this is safe to leave on. Turn it <b>off</b> for a carrier
        whose AAA rejects it on every reconnect (O2 UK) to skip that wasted
        attach attempt.
      </Hint>
    </CollapsibleCard>
  );
}
