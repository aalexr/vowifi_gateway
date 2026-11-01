import React from "react";
import type { InstanceConfig } from "../../api";
import CheckboxRow from "./CheckboxRow";
import Field from "./Field";
import Section from "./Section";
import type { SipSectionProps } from "./types";
import { PANI_ACCESS_TYPES, paniCustomised, previewPani } from "./utils";

interface PaniSectionProps extends Omit<SipSectionProps, "upd"> {
  /** The saved instance (not the live form): opens the section if PANI was customised. */
  saved?: InstanceConfig | null;
}

/** P-Access-Network-Info knobs plus a live preview of the resulting header. */
export default function PaniSection({ form, updSip, saved }: PaniSectionProps) {
  const sip = form.sip;
  return (
    <Section
      title="P-Access-Network-Info"
      collapsible
      defaultOpen={paniCustomised(saved)}
      resetKey={saved?.id}
      desc={
        <>
          Identifies the Wi-Fi access on REGISTER / SIP. Default matches real
          phones: <code>IEEE-802.11;country=&lt;SIM home country&gt;</code>
        </>
      }
    >
      <Field label="Access type">
        <select
          value={sip.pani_access_type || "IEEE-802.11"}
          onChange={(e) => updSip({ pani_access_type: e.target.value })}
        >
          {PANI_ACCESS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <CheckboxRow
        checked={sip.pani_country_enable !== false}
        onChange={(pani_country_enable) => updSip({ pani_country_enable })}
      >
        Report country code
      </CheckboxRow>
      {sip.pani_country_enable !== false && (
        <input
          className="mono"
          maxLength={2}
          style={{ marginTop: 6 }}
          value={sip.pani_country || ""}
          onChange={(e) =>
            updSip({
              pani_country: e.target.value
                .toUpperCase()
                .replace(/[^A-Z]/g, "")
                .slice(0, 2),
            })
          }
          placeholder="empty = derive from the SIM's MCC (e.g. GB)"
        />
      )}
      <CheckboxRow
        checked={!!sip.pani_node_id_enable}
        onChange={(pani_node_id_enable) => updSip({ pani_node_id_enable })}
      >
        Report Wi-Fi AP BSSID (i-wlan-node-id)
      </CheckboxRow>
      {!!sip.pani_node_id_enable && (
        <input
          className="mono"
          style={{ marginTop: 6 }}
          value={sip.pani_node_id || ""}
          onChange={(e) => updSip({ pani_node_id: e.target.value })}
          placeholder="000cf1126028"
        />
      )}
      <div className="mono pani-preview">
        P-Access-Network-Info: {previewPani(sip, form.mcc)}
      </div>
    </Section>
  );
}
