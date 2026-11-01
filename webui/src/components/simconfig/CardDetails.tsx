import React from "react";
import type { CardInfo } from "../../api";

/** Readout of the last "Detect card" result. */
export default function CardDetails({ card }: { card: CardInfo }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 12,
        color: card.present ? "var(--text-dim)" : "var(--danger)",
        marginTop: 12,
        lineHeight: 1.6,
      }}
    >
      {card.present ? (
        <>
          ICCID: {card.iccid || "—"}
          <br />
          IMSI: {card.imsi || "(locked)"}
          <br />
          {card.reader_port && (
            <>
              USB port: {card.reader_port}
              <br />
            </>
          )}
          PIN:{" "}
          {card.pin_enabled ? `enabled, ${card.pin_tries} tries` : "disabled"}
        </>
      ) : (
        <>No SIM card in reader {card.reader_index}.</>
      )}
    </div>
  );
}
