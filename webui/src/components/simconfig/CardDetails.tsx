import React from "react";
import type { CardInfo } from "../../api";

/** Readout of the last "Detect card" result. */
export default function CardDetails({ card }: { card: CardInfo }) {
  if (!card.present)
    return (
      <div className="banner banner-danger" style={{ marginTop: 12 }}>
        No SIM card in reader {card.reader_index}.
      </div>
    );
  return (
    <dl className="simcfg-facts mono">
      <dt>ICCID</dt>
      <dd>{card.iccid || "—"}</dd>
      <dt>IMSI</dt>
      <dd>{card.imsi || "(locked)"}</dd>
      {card.reader_port && (
        <>
          <dt>USB port</dt>
          <dd>{card.reader_port}</dd>
        </>
      )}
      <dt>PIN</dt>
      <dd>
        {card.pin_enabled ? `enabled, ${card.pin_tries} tries` : "disabled"}
      </dd>
    </dl>
  );
}
