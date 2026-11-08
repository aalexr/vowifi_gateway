import React from "react";
import type { FixedSmsConfig, InstanceConfig } from "../../api";
import CheckboxRow from "./CheckboxRow";
import Field from "./Field";
import Hint from "./Hint";
import Section from "./Section";
import type { SipSectionProps } from "./types";

interface FixedSmsSectionProps extends Omit<SipSectionProps, "upd"> {
  /** The saved instance (not the live form): opens the section if it is already enabled. */
  saved?: InstanceConfig | null;
}

/**
 * Landline SMS ("Festnetz-SMS", ETSI ES 201 912) for a DECT base such as a Gigaset analog base
 * on a FRITZ!Box FON port. The engine answers the base's calls to the SMS centre number and
 * calls the base (caller ID = that number) to deliver incoming SMS.
 */
export default function FixedSmsSection({
  form,
  updSip,
  saved,
}: FixedSmsSectionProps) {
  const fs: FixedSmsConfig = form.sip.fixed_sms || {};
  const set = (patch: Partial<FixedSmsConfig>) =>
    updSip({ fixed_sms: { ...fs, ...patch } });
  const accounts = (form.sip.external || [])
    .map((a) => (a.username || "").trim())
    .filter(Boolean);
  const number = fs.number ?? "7676";
  const numberOk = /^[0-9*#]{2,20}$/.test(number);
  const accountOk = !!fs.account && accounts.includes(fs.account);
  return (
    <Section
      title="Landline SMS to a DECT base"
      desc="Send and receive SMS on a DECT handset through a base with landline SMS (e.g. Gigaset)."
      collapsible
      defaultOpen={!!saved?.sip?.fixed_sms?.enable}
      resetKey={saved?.id}
    >
      <CheckboxRow
        checked={!!fs.enable}
        onChange={(enable) => set({ enable })}
      >
        Enable landline SMS
      </CheckboxRow>
      <div className="form-grid">
        <Field label="SMS centre number (as set in the base)">
          <input
            className="mono"
            value={number}
            onChange={(e) =>
              set({ number: e.target.value.replace(/[^0-9*#]/g, "") })
            }
            placeholder="7676"
          />
        </Field>
        <Field label="SIP account that rings only the base">
          <select
            value={fs.account || ""}
            onChange={(e) => set({ account: e.target.value })}
          >
            <option value="">— choose an external account —</option>
            {accounts.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {fs.enable && (!numberOk || !accountOk) && (
        <Hint style={{ color: "var(--danger)" }}>
          {!numberOk
            ? "The SMS centre number must be 2–20 digits."
            : "Choose one of this line's external SIP accounts (add one under Local SIP access)."}{" "}
          Landline SMS stays off until this is fixed.
        </Hint>
      )}
      <Hint>
        Use a <b>separate</b> external SIP account for this, registered in the
        FRITZ!Box as its own telephone number and assigned only to the FON
        port of the base. The gateway calls the base on it (caller ID{" "}
        <code>{number || "7676"}</code>) to deliver each SMS, so it never rings
        for normal calls. The base sends SMS by dialling{" "}
        <code>{number || "7676"}</code>; let the FRITZ!Box route that number
        to this line and keep the call G.711. Restart the line after changing
        this.
      </Hint>
    </Section>
  );
}
