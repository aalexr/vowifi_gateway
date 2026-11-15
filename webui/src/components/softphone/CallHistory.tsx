import React from "react";
import {
  ListCheck,
  Phone as PhoneIcon,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneLog,
} from "lucide-react";
import type { CallRecord } from "../../api";
import { codecLabel, sdpListLabel } from "../common/codecs";

interface Props {
  calls: CallRecord[];
  selMode: boolean;
  sel: Set<number>;
  onToggleSel: (id: number) => void;
  onSelMode: (on: boolean) => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  /** Placing a call is possible (browser registered). */
  canCall: boolean;
  onCall: (peer: string) => void;
  /** Row tap outside select mode: put the number in the dialer. */
  onPick: (peer: string) => void;
}

// Call dispositions the control plane writes (api/events.rs call_disposition + the live
// "ringing"/"dialing" rows), worded for a person.
const STATUS_LABEL: Record<string, string> = {
  answered: "Answered",
  missed: "Missed",
  rejected: "Declined",
  busy: "Busy",
  "no answer": "No answer",
  cancelled: "Cancelled",
  failed: "Failed",
  ringing: "Ringing",
  dialing: "Dialing",
};

const statusOf = (c: CallRecord) => {
  const s = (c.status || "").toLowerCase();
  if ((s === "ringing" || s === "dialing" || !s) && !c.end_ts)
    return { label: "In progress", tone: "" };
  const label = STATUS_LABEL[s] || (s ? s[0].toUpperCase() + s.slice(1) : "Unknown");
  // Colour is reserved for a call the network failed; a missed call is just made heavier
  // (it's the one row that may need a call back). Everything else stays neutral ink.
  const tone = s === "failed" ? "is-failed" : s === "missed" ? "is-missed" : "";
  return { label, tone };
};

const DAY = 86400000;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
/** "14:02" today, "Yesterday 14:02", "12 Nov 14:02" before that. */
function fmtWhen(ts?: number) {
  if (!ts) return "";
  const d = new Date(Number(ts) * 1000);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = timeFmt.format(d);
  if (d.getTime() >= today.getTime()) return t;
  if (d.getTime() >= today.getTime() - DAY) return `Yesterday ${t}`;
  return `${dateFmt.format(d)} ${t}`;
}

/** Carrier-leg codec ↔ local-client codec, plus the SDP lines behind it. */
function codecInfo(c: CallRecord) {
  const [carrier, client] = [c.carrier_codec, c.client_codec].map((x) =>
    x ? codecLabel(x) : "",
  );
  const summary = carrier ? (client && client !== carrier ? `${carrier} ↔ ${client}` : carrier) : "";
  const lines = [
    c.carrier_sdp &&
      `Carrier ${c.direction === "in" ? "offer" : "answer"}: ${sdpListLabel(c.carrier_sdp)}${
        c.carrier_bw ? ` (b=${c.carrier_bw})` : ""
      }`,
    c.our_sdp &&
      `${c.direction === "in" ? "Our answer" : "Negotiated"}: ${sdpListLabel(c.our_sdp)}`,
    c.client_sdp && `Local client: ${sdpListLabel(c.client_sdp)}`,
  ].filter(Boolean) as string[];
  return { summary, lines };
}

/** Recent calls for the selected line: a diagnostic log first (codec per leg, SDP on demand),
 *  a redial list second. Deleting goes through select mode so it never sits next to Call. */
export default function CallHistory({
  calls,
  selMode,
  sel,
  onToggleSel,
  onSelMode,
  onDeleteSelected,
  onClearAll,
  canCall,
  onCall,
  onPick,
}: Props) {
  return (
    <div className="card pane-detail softphone-history">
      <div className="call-history-head">
        <h2 className="call-history-title">
          <PhoneLog size={16} aria-hidden="true" />
          Recent calls
        </h2>
        {calls.length > 0 &&
          (selMode ? (
            <div className="call-history-tools">
              <span className="call-history-count" aria-live="polite">
                {sel.size} selected
              </span>
              <button
                type="button"
                className="btn btn-ghost call-tool is-danger"
                disabled={!sel.size}
                onClick={onDeleteSelected}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn btn-ghost call-tool"
                onClick={() => onSelMode(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="call-history-tools">
              <button
                type="button"
                className="btn btn-ghost call-tool"
                onClick={() => onSelMode(true)}
              >
                <ListCheck size={14} aria-hidden="true" />
                Select
              </button>
              <button
                type="button"
                className="btn btn-ghost call-tool is-danger"
                onClick={onClearAll}
              >
                Clear all
              </button>
            </div>
          ))}
      </div>
      {calls.length === 0 ? (
        <p className="call-history-empty">No calls yet.</p>
      ) : (
        <ul className="call-list">
          {calls.map((c) => {
            const peer = (c.peer || "").trim();
            const checked = sel.has(c.id);
            const DirIcon = c.direction === "in" ? PhoneIncoming : PhoneOutgoing;
            const dir = c.direction === "in" ? "Incoming" : "Outgoing";
            const st = statusOf(c);
            const codec = codecInfo(c);
            return (
              <li key={c.id} className={`call-row${checked ? " is-selected" : ""}`}>
                <button
                  type="button"
                  className="call-row-main"
                  onClick={() => (selMode ? onToggleSel(c.id) : peer && onPick(peer))}
                  aria-pressed={selMode ? checked : undefined}
                  disabled={!selMode && !peer}
                  title={selMode ? undefined : peer ? `Put ${peer} in the dialer` : undefined}
                >
                  {selMode && (
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      aria-hidden="true"
                      readOnly
                      checked={checked}
                    />
                  )}
                  <DirIcon size={14} aria-label={dir} className="call-row-dir" />
                  <span className="call-row-who">
                    <span className={`mono call-row-peer${peer ? "" : " is-private"}`}>
                      {peer || "Private number"}
                    </span>
                    <span className="call-row-when">{fmtWhen(c.start_ts)}</span>
                  </span>
                </button>
                <div className="call-row-codec">
                  {codec.summary &&
                    (codec.lines.length ? (
                      <details>
                        <summary className="mono">{codec.summary}</summary>
                        <div className="mono call-row-sdp">
                          {codec.lines.map((l) => (
                            <div key={l}>{l}</div>
                          ))}
                        </div>
                      </details>
                    ) : (
                      <span className="mono">{codec.summary}</span>
                    ))}
                </div>
                <span className={`call-row-status ${st.tone}`}>{st.label}</span>
                {!selMode && (
                  <button
                    type="button"
                    className="call-row-call"
                    disabled={!canCall || !peer}
                    onClick={() => onCall(peer)}
                    aria-label={peer ? `Call ${peer}` : "Call"}
                    title={peer ? `Call ${peer}` : undefined}
                  >
                    <PhoneIcon size={17} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
