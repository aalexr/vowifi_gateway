import React from "react";
import CheckboxRow from "./CheckboxRow";
import Field from "./Field";
import Hint from "./Hint";
import type { SipSectionProps } from "./types";
import { PANI_ACCESS_TYPES, previewPani } from "./utils";

/** P-Access-Network-Info knobs plus a live preview of the resulting header. */
export default function PaniSettings({
  form,
  updSip,
}: Omit<SipSectionProps, "upd">) {
  const sip = form.sip;
  return (
    <>
      <h4 style={{ marginBottom: 6, marginTop: 16 }}>P-Access-Network-Info</h4>
      <Hint marginBottom={8}>
        Sent on IMS REGISTER / SIP to identify the Wi-Fi access. Default matches
        real phones:
        <code style={{ marginLeft: 4 }}>
          IEEE-802.11;country=&lt;SIM home country&gt;
        </code>
      </Hint>
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
        marginTop={10}
        checked={sip.pani_country_enable !== false}
        onChange={(pani_country_enable) => updSip({ pani_country_enable })}
      >
        Report country code
      </CheckboxRow>
      {sip.pani_country_enable !== false && (
        <div style={{ marginTop: 6 }}>
          <input
            className="mono"
            maxLength={2}
            value={sip.pani_country || ""}
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
      <CheckboxRow
        marginTop={10}
        checked={!!sip.pani_node_id_enable}
        onChange={(pani_node_id_enable) => updSip({ pani_node_id_enable })}
      >
        Report Wi-Fi AP BSSID (i-wlan-node-id)
      </CheckboxRow>
      {!!sip.pani_node_id_enable && (
        <div style={{ marginTop: 6 }}>
          <input
            className="mono"
            value={sip.pani_node_id || ""}
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
        Preview: P-Access-Network-Info: {previewPani(sip, form.mcc)}
      </div>
    </>
  );
}
