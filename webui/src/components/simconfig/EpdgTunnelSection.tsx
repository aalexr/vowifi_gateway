import React from "react";
import CheckboxRow from "./CheckboxRow";
import Field from "./Field";
import Hint from "./Hint";
import Section from "./Section";
import type { FormSectionProps } from "./types";

/** SWu tunnel parameters: APN, IDr encoding, IMS address family, EAP-AKA re-auth. */
const CP_MODES: [string, string][] = [
  ["dual", "Dual-stack (IPv4+IPv6)"],
  ["v6", "IPv6 only"],
  ["v4", "IPv4 only"],
];

export default function EpdgTunnelSection({ form, upd }: FormSectionProps) {
  // Auto-detect pins the family that worked; the select then shows it, marked as detected.
  const pinnedByAuto =
    !!form.cp_mode && form.cp_mode !== "auto" && form.cp_mode_source === "auto";
  return (
    <Section title="ePDG tunnel">
      <div className="form-grid">
        <Field label="APN">
          <input
            className="mono"
            value={form.apn ?? "ims"}
            onChange={(e) => upd({ apn: e.currentTarget.value })}
            placeholder="ims"
          />
        </Field>
        <Field label="ePDG identity (IDr)">
          <select
            value={form.idr_mode ?? "apn"}
            onChange={(e) => upd({ idr_mode: e.currentTarget.value })}
          >
            <option value="apn">Bare APN (default)</option>
            <option value="fqdn">APN-FQDN</option>
          </select>
        </Field>
        <Field label="IMS address family (CP)">
          <select
            value={form.cp_mode ?? "auto"}
            onChange={(e) => upd({ cp_mode: e.currentTarget.value })}
          >
            <option value="auto">Auto-detect (recommended)</option>
            {CP_MODES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
                {pinnedByAuto && form.cp_mode === v ? " (auto-detected)" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Hint>
        <b>APN-FQDN</b> (
        <code>&lt;apn&gt;.apn.epc.mnc…mcc….pub.3gppnetwork.org</code>) only
        for carriers that require it; some reject it.{" "}
        {pinnedByAuto ? (
          <>Choose Auto-detect to probe the address families again.</>
        ) : (
          <>
            Auto-detect probes the families after SIM auth and pins the one
            that works.
          </>
        )}
      </Hint>
      <CheckboxRow
        checked={form.use_reauth_id !== false}
        onChange={(use_reauth_id) => upd({ use_reauth_id })}
      >
        Use EAP-AKA fast re-authentication
      </CheckboxRow>
      <Hint>
        An expired re-auth identity falls back to the IMSI by itself. Turn off
        for a carrier whose AAA rejects it on every reconnect (O2 UK).
      </Hint>
    </Section>
  );
}
