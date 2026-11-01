import React from "react";
import CheckboxRow from "./CheckboxRow";
import ExternalAccounts from "./ExternalAccounts";
import Field from "./Field";
import Section from "./Section";
import type { SipSectionProps } from "./types";
import { sipUsernameConflict } from "./utils";

interface LocalSipSectionProps extends Omit<SipSectionProps, "upd"> {
  /** Offer the "LAN IP" listen address (only once the line has a status). */
  allowLanListen: boolean;
}

/** How local phones / the browser reach this line, plus the carrier-facing User-Agent. */
export default function LocalSipSection({
  form,
  updSip,
  allowLanListen,
}: LocalSipSectionProps) {
  const sip = form.sip;
  return (
    <Section
      title="Local SIP access"
      desc="How phones and SIP clients on your network reach this line."
    >
      <div className="form-grid">
        <Field label="Listen address">
          <select
            value={sip.listen_addr}
            onChange={(e) => updSip({ listen_addr: e.target.value })}
          >
            <option value="0.0.0.0">0.0.0.0 (all)</option>
            <option value="127.0.0.1">127.0.0.1 (local)</option>
            {allowLanListen && <option value="lan">LAN IP</option>}
          </select>
        </Field>
        <Field label="Transport">
          <select
            value={sip.transport}
            onChange={(e) => updSip({ transport: e.target.value })}
          >
            <option value="udp">UDP</option>
            <option value="tcp">TCP</option>
            <option value="tls">TLS</option>
          </select>
        </Field>
        <Field
          label="Device User-Agent (identify to the carrier as this device)"
          wide
        >
          <input
            className="mono"
            value={sip.user_agent || ""}
            onChange={(e) => updSip({ user_agent: e.target.value })}
            placeholder="iOS/26.6 iPhone"
          />
        </Field>
      </div>
      <CheckboxRow
        checked={!!sip.webrtc?.enable}
        onChange={(enable) => updSip({ webrtc: { ...sip.webrtc, enable } })}
      >
        Enable browser softphone (WebRTC)
      </CheckboxRow>

      <ExternalAccounts
        accounts={sip.external || []}
        onChange={(external) => updSip({ external })}
        error={sipUsernameConflict(sip)}
      />
    </Section>
  );
}
