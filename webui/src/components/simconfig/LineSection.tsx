import React from "react";
import { Trash2 } from "lucide-react";
import Field from "./Field";
import Hint from "./Hint";
import Section from "./Section";
import type { FormSectionProps } from "./types";

interface LineSectionProps extends FormSectionProps {
  /** The form is an existing line: its id is fixed (it keys ports, PIN and logs). */
  saved: boolean;
  busy: boolean;
  onDelete: () => void;
}

/** How this line is identified in the gateway, and removing it. */
export default function LineSection({
  form,
  upd,
  saved,
  busy,
  onDelete,
}: LineSectionProps) {
  return (
    <Section title="Line">
      <div className="form-grid">
        <Field label="Instance ID">
          <input
            className="mono"
            value={form.id}
            readOnly={saved}
            onChange={(e) => upd({ id: e.currentTarget.value })}
            placeholder="1"
          />
        </Field>
        <Field label="Name">
          <input
            value={form.name}
            onChange={(e) => upd({ name: e.currentTarget.value })}
            placeholder="e.g. O2 UK"
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
      {saved && (
        <div className="simcfg-delete-row">
          <Hint style={{ margin: 0 }}>
            Deleting stops the line&apos;s engine and removes its config.
          </Hint>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 size={16} aria-hidden /> Delete line
          </button>
        </div>
      )}
    </Section>
  );
}
