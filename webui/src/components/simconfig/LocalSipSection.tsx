import React from "react";
import CheckboxRow from "./CheckboxRow";
import CollapsibleCard from "./CollapsibleCard";
import ExternalAccounts from "./ExternalAccounts";
import Field from "./Field";
import PaniSettings from "./PaniSettings";
import type { SipSectionProps } from "./types";
import { sipUsernameConflict } from "./utils";

interface LocalSipSectionProps extends SipSectionProps {
  /** Offer the "LAN IP" listen address (only once the line has a status). */
  allowLanListen: boolean;
}

/** How local phones / the browser reach this line, plus carrier-facing SIP identity. */
export default function LocalSipSection({
  form,
  updSip,
  allowLanListen,
}: LocalSipSectionProps) {
  const sip = form.sip;
  const sipUserError = sipUsernameConflict(sip);
  const accounts = sip.external || [];
  const summary = [
    `${sip.listen_addr} / ${String(sip.transport || "").toUpperCase()}`,
    sip.webrtc?.enable && "WebRTC",
    accounts.length &&
      `${accounts.length} account${accounts.length > 1 ? "s" : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CollapsibleCard id="sip" title="Local SIP access" summary={summary}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
      </div>
      <CheckboxRow
        marginTop={8}
        checked={!!sip.webrtc?.enable}
        onChange={(enable) => updSip({ webrtc: { ...sip.webrtc, enable } })}
      >
        Enable browser softphone (WebRTC)
      </CheckboxRow>

      <div style={{ marginTop: 12 }}>
        <label>
          Device User-Agent (identify to the carrier as this device)
        </label>
        <input
          className="mono"
          value={sip.user_agent || ""}
          onChange={(e) => updSip({ user_agent: e.target.value })}
          placeholder="iOS/26.6 iPhone"
        />
      </div>

      <PaniSettings form={form} updSip={updSip} />

      <ExternalAccounts
        accounts={accounts}
        onChange={(external) => updSip({ external })}
        error={sipUserError}
      />
    </CollapsibleCard>
  );
}
