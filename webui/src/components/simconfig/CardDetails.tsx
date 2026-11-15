import React from "react";
import type { CardFacts } from "./pin";

/** Readout of the card in the selected reader (live monitor or the last "Detect card"). */
export default function CardDetails({
  facts,
  readerIdx,
  tries,
  enabled,
}: {
  facts: CardFacts;
  readerIdx: number;
  /** PIN enabled on the SIM (pin.ts `pinEnabled`); null = not known yet. */
  enabled: boolean | null;
  /** Remaining PIN attempts from the best source (see pin.ts `pinTries`). */
  tries: number | null;
}) {
  if (!facts.present)
    return (
      <div className="banner banner-danger" style={{ marginTop: 12 }}>
        No SIM card in reader {readerIdx}.
      </div>
    );
  const pin =
    enabled == null
      ? "not read yet"
      : !enabled
        ? "disabled"
        : tries == null
          ? "enabled"
          : tries <= 0
            ? "blocked (PUK needed)"
            : `enabled · ${tries} ${tries === 1 ? "try" : "tries"} left`;
  return (
    <dl className="simcfg-facts">
      <dt>ICCID</dt>
      <dd className="mono">{facts.iccid || "—"}</dd>
      <dt>IMSI</dt>
      <dd className="mono">{facts.imsi || "locked"}</dd>
      {facts.reader_port && (
        <>
          <dt>USB port</dt>
          <dd className="mono">{facts.reader_port}</dd>
        </>
      )}
      <dt>PIN</dt>
      <dd>{pin}</dd>
    </dl>
  );
}
