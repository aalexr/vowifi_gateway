import React from "react";
import Field from "./Field";
import Section from "./Section";
import SmscField, { type SmscMode } from "./SmscField";
import type { FormSectionProps } from "./types";

interface SubscriberSectionProps extends FormSectionProps {
  smscMode: SmscMode;
  onSmscModeChange: (mode: SmscMode) => void;
}

/** SIM identity (IMSI/MCC/MNC), the device identity presented to the network, and the SMSC. */
export default function SubscriberSection({
  form,
  upd,
  smscMode,
  onSmscModeChange,
}: SubscriberSectionProps) {
  return (
    <Section
      title="Subscriber & device"
      desc="Read from the SIM; the IMEI is what the line presents to the network."
    >
      <div className="form-grid form-grid-4">
        <Field label="IMSI" wide>
          <input
            className="mono"
            value={form.imsi}
            onChange={(e) => upd({ imsi: e.target.value })}
          />
        </Field>
        <Field label="MCC">
          <input
            className="mono"
            value={form.mcc}
            onChange={(e) => upd({ mcc: e.target.value })}
          />
        </Field>
        <Field label="MNC">
          <input
            className="mono"
            value={form.mnc}
            onChange={(e) => upd({ mnc: e.target.value })}
          />
        </Field>
        <Field label="IMEI" wide>
          <input
            className="mono"
            value={form.imei}
            onChange={(e) => upd({ imei: e.target.value })}
            placeholder="35123456-789012-3"
          />
        </Field>
        <Field label="IMEISV" wide>
          <input
            className="mono"
            value={form.imeisv || ""}
            onChange={(e) =>
              upd({ imeisv: e.target.value.replace(/[^0-9]/g, "") })
            }
            maxLength={16}
            placeholder="auto from IMEI"
          />
        </Field>
      </div>
      <SmscField
        value={form.smsc || ""}
        onChange={(smsc) => upd({ smsc })}
        mode={smscMode}
        onModeChange={onSmscModeChange}
      />
    </Section>
  );
}
