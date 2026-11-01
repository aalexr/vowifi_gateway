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
        <Field label="Phone number (MSISDN)">
          <input
            className="mono"
            value={form.msisdn}
            onChange={(e) => upd({ msisdn: e.target.value })}
            placeholder="auto-learned"
          />
        </Field>
        <Field label="Reader match">
          <input
            className="mono"
            value={form.reader}
            onChange={(e) => upd({ reader: e.target.value })}
            placeholder="imsi:302..."
          />
        </Field>
      </div>
    </Section>
  );
}
