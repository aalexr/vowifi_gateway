import React, { useEffect, useState } from "react";
import { api } from "../../api";
import type { CarrierCodecsSeen as Seen, InstanceId } from "../../api";
import { codecLabel, codecSetting } from "../common/codecs";

interface Props {
  id?: InstanceId;
  /** The line's current carrier codec list (ims_codecs keys), to mark what it uses. */
  configured: string[];
}

/** What the carrier has offered/answered in this line's logged calls (call log SDP). */
export default function CarrierCodecsSeen({ id, configured }: Props) {
  const [seen, setSeen] = useState<Seen | null>(null);
  useEffect(() => {
    setSeen(null);
    if (!id) return;
    api
      .carrierCodecs(id)
      .then(setSeen)
      .catch(() => setSeen(null));
  }, [id]);

  if (!seen) return null;
  const none = !seen.incoming_calls && !seen.outgoing_calls;
  const chip = (name: string, calls: number, total: number, key: string) => {
    const setting = codecSetting(name);
    const used = setting !== undefined && configured.includes(setting);
    return (
      <span
        key={key}
        className="mono"
        title={`${name}: ${calls} of ${total} call${total === 1 ? "" : "s"}${
          setting === undefined
            ? " · the gateway can't use this codec towards the carrier"
            : used
              ? " · in this line's list"
              : ` · not in this line's list (${setting})`
        }`}
        style={{
          display: "inline-block",
          padding: "2px 8px",
          margin: "0 6px 6px 0",
          borderRadius: 999,
          fontSize: 12,
          border: "1px solid var(--border)",
          background: used ? "var(--active)" : "transparent",
          color: used ? undefined : "var(--text-mute)",
        }}
      >
        {codecLabel(name)}
        {calls < total ? ` ${calls}/${total}` : ""}
      </span>
    );
  };

  return (
    <div style={{ fontSize: 13, margin: "4px 0 10px" }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Seen from this carrier</div>
      {none ? (
        <div style={{ color: "var(--text-mute)" }}>
          Nothing logged yet. Each call records the carrier's codecs (needs a current
          engine image); an incoming call shows everything the carrier accepts.
        </div>
      ) : (
        <>
          {seen.offered.length > 0 && (
            <div>
              <span style={{ color: "var(--text-dim)", marginRight: 8 }}>
                Offers on incoming calls:
              </span>
              {seen.offered.map((c) =>
                chip(c.name, c.calls, seen.incoming_calls, `o-${c.name}`),
              )}
            </div>
          )}
          {seen.answered.length > 0 && (
            <div>
              <span style={{ color: "var(--text-dim)", marginRight: 8 }}>
                Answers to outgoing calls:
              </span>
              {seen.answered.map((c) =>
                chip(c.name, c.calls, seen.outgoing_calls, `a-${c.name}`),
              )}
            </div>
          )}
          {seen.bandwidth.length > 0 && (
            <div style={{ color: "var(--text-dim)" }}>
              Bandwidth (b=):{" "}
              <span className="mono">
                {seen.bandwidth.map((b) => b.name).join(", ")}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
