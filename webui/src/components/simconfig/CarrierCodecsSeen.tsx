import React, { useEffect, useState } from "react";
import { api } from "../../api";
import type { CarrierCodecsSeen as Seen, InstanceId } from "../../api";
import { codecLabel, codecSetting } from "../common/codecs";

interface Props {
  id?: InstanceId;
  /** Carrier codecs the gateway uses (codecSetting keys), to mark them. */
  supported: string[];
}

/** What the carrier has offered/answered in this line's logged calls (call log SDP). */
export default function CarrierCodecsSeen({ id, supported }: Props) {
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
  const isUsed = (name: string) => {
    const setting = codecSetting(name);
    return setting !== undefined && supported.includes(setting);
  };
  const anyUnused = [...seen.offered, ...seen.answered].some(
    (c) => !isUsed(c.name),
  );
  const chip = (name: string, calls: number, total: number, key: string) => {
    const used = isUsed(name);
    return (
      <span
        key={key}
        className={`pill codec-chip${used ? "" : " codec-chip-unused"}`}
        title={`${name}: ${calls} of ${total} call${total === 1 ? "" : "s"}`}
      >
        {codecLabel(name)}
        {calls < total ? ` ${calls}/${total}` : ""}
        {!used && <span className="sr-only"> (not used by the gateway)</span>}
      </span>
    );
  };

  return (
    <div style={{ fontSize: 13, margin: "4px 0 10px" }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Seen from this carrier</div>
      {none ? (
        <div style={{ color: "var(--text-dim)" }}>
          Nothing logged yet. An incoming call shows everything the carrier
          accepts.
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
          {anyUnused && (
            <div className="hint" style={{ marginTop: 0 }}>
              Dashed: the carrier sent it, the gateway doesn&apos;t use it
              towards the carrier.
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
