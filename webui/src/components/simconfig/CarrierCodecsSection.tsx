import React, { useEffect, useState } from "react";
import type { InstanceConfig } from "../../api";
import Field from "./Field";
import Hint from "./Hint";
import Section from "./Section";
import CarrierCodecsSeen from "./CarrierCodecsSeen";
import type { FormSectionProps } from "./types";
import { IMS_CODECS_DEFAULT, imsCodecsCustomised } from "./utils";

const PRESETS: { key: string; label: string; codecs: string[] }[] = [
  {
    key: "phone",
    label: "AMR-WB, AMR — like a phone (default)",
    codecs: IMS_CODECS_DEFAULT,
  },
  {
    key: "g722",
    label: "G.722 first, then AMR-WB, AMR",
    codecs: ["g722", "amrwb", "amr"],
  },
  {
    key: "amr",
    label: "AMR, then AMR-WB — narrowband first",
    codecs: ["amr", "amrwb"],
  },
  {
    key: "evs",
    label: "EVS first, then AMR-WB, AMR — needs an EVS engine image",
    codecs: ["evs", "amrwb", "amr"],
  },
];

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((c, i) => c === b[i]);

interface CarrierCodecsSectionProps extends FormSectionProps {
  /** The saved instance (not the live form): opens the section if it already differs. */
  saved?: InstanceConfig | null;
}

/** Codecs this line offers/accepts towards the carrier (the IMS leg), in preference order. */
export default function CarrierCodecsSection({
  form,
  upd,
  saved,
}: CarrierCodecsSectionProps) {
  const codecs = form.ims_codecs?.length ? form.ims_codecs : IMS_CODECS_DEFAULT;
  const preset = PRESETS.find((p) => sameList(p.codecs, codecs))?.key ?? "custom";
  const [text, setText] = useState(codecs.join(", "));
  useEffect(() => {
    setText(codecs.join(", "));
  }, [form.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    const next = p ? p.codecs : codecs;
    setText(next.join(", "));
    upd({ ims_codecs: [...next] });
  };

  return (
    <Section
      title="Carrier codecs"
      desc="Advanced — which voice codecs this line uses towards the carrier."
      collapsible
      defaultOpen={imsCodecsCustomised(saved)}
      resetKey={saved?.id}
    >
      <div className="form-grid">
        <Field label="Preference" wide>
          <select
            value={preset}
            onChange={(e) => choose(e.currentTarget.value)}
          >
            {PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </Field>
        {preset === "custom" && (
          <Field label="Codecs, in order (evs, amrwb, amr, g722, alaw, ulaw)" wide>
            <input
              className="mono"
              value={text}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setText(value);
                upd({
                  ims_codecs: value
                    .split(",")
                    .map((c) => c.trim().toLowerCase())
                    .filter(Boolean),
                });
              }}
              placeholder="g722, amrwb, amr"
            />
          </Field>
        )}
      </div>
      <CarrierCodecsSeen id={form.id} configured={codecs} />
      <Hint>
        The default offers what a phone offers. Put <b>G.722</b> first only for
        carriers that really carry it (O2 Germany does; Vodafone Germany offers it
        but limits the call to 50 kbit/s, which clips G.722): calls with a G.722 phone such
        as a FRITZ!Box DECT HD handset then pass through without transcoding
        here, and the carrier converts to AMR-WB where needed. Put <b>AMR</b> first
        for carriers that end incoming calls answered with AMR-WB ("Media
        Negotiation Failed", Beeline RU). An incoming call answers with the
        codecs of this list the carrier offered (only the first one with{" "}
        <b>Incoming calls: answer with a single speech codec</b>). The list must keep
        AMR-WB or AMR. <b>EVS</b> only works on an engine image built with{" "}
        <code>EVS_CODEC=1</code> (see the README); on other images it is
        ignored. For Beeline RU try <code>evs, amr</code>. Restart the line
        after changing this.
      </Hint>
    </Section>
  );
}
