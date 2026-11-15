import React from "react";
import type { InstanceId } from "../../api";
import Hint from "./Hint";
import Section from "./Section";
import CarrierCodecsSeen from "./CarrierCodecsSeen";

/** Carrier (IMS) leg codecs the gateway uses on every line: what a phone offers. Mirrors
 *  engine render.py _IMS_CODECS_PHONE (EVS only on an engine image built with EVS_CODEC=1). */
export const CARRIER_CODECS = ["evs", "amrwb", "amr"];

/** Read-only: the carrier codecs are not a per-line setting; this shows what the carrier
 *  has used in the line's logged calls. */
export default function CarrierCodecsSection({ id }: { id?: InstanceId }) {
  return (
    <Section
      title="Carrier codecs"
      collapsible
      defaultOpen={false}
      resetKey={id}
    >
      <CarrierCodecsSeen id={id} supported={CARRIER_CODECS} />
      <Hint>
        Every line offers <b>EVS</b> (engine image built with{" "}
        <code>EVS_CODEC=1</code>), <b>AMR-WB</b>, <b>AMR</b> in that order;
        incoming calls follow the carrier&apos;s order.
      </Hint>
    </Section>
  );
}
