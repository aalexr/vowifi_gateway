import React from "react";
import CheckboxRow from "./CheckboxRow";
import Field from "./Field";
import Hint from "./Hint";
import Section from "./Section";
import type { FormSectionProps } from "./types";

/** SWu tunnel parameters: APN, IDr encoding, IMS address family, EAP-AKA re-auth. */
export default function EpdgTunnelSection({ form, upd }: FormSectionProps) {
  return (
    <Section
      title="ePDG tunnel"
      desc="IKEv2 / EAP-AKA attach to the carrier's Wi-Fi calling gateway."
    >
      <div className="form-grid">
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
        </Field>
      </div>
      {form.cp_mode &&
        form.cp_mode !== "auto" &&
        form.cp_mode_source === "auto" && (
          <Hint>
            Auto-detected: {form.cp_mode.toUpperCase()}. Switch back to
            Auto-detect to re-probe.
          </Hint>
        )}
      <Hint>
        <b>IDr</b> is how the APN is presented to the ePDG. <b>Bare APN</b>{" "}
        (just the APN string) is what most carriers' ePDGs expect and is the
        safe default; <b>APN-FQDN</b> (
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
    </Section>
  );
}
