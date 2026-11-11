import React from "react";
import Field from "./Field";
import Section from "./Section";
import type { FormSectionProps } from "./types";

/** How this line is identified in the gateway. */
export default function LineSection({ form, upd }: FormSectionProps) {
  return (
    <Section title="Line" desc="How this line is identified in the gateway.">
      <div className="form-grid">
        <Field label="Instance ID">
          <input
            value={form.id}
            onChange={(e) => upd({ id: e.currentTarget.value })}
            placeholder="1"
          />
        </Field>
        <Field label="Name">
          <input
            value={form.name}
            onChange={(e) => upd({ name: e.currentTarget.value })}
            placeholder="Telus"
          />
        </Field>
        <Field label="Phone number (MSISDN)">
          <input
            className="mono"
            value={form.msisdn}
            onChange={(e) => upd({ msisdn: e.currentTarget.value })}
            placeholder="auto-learned"
          />
        </Field>
        <Field label="Reader match">
          <input
            className="mono"
            value={form.reader}
            onChange={(e) => upd({ reader: e.currentTarget.value })}
            placeholder="imsi:302..."
          />
        </Field>
      </div>
    </Section>
  );
}
