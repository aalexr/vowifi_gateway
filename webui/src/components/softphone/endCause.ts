import type { EndInfo } from "../../softphone";

/** How the call screen words an ending. `failed` endings stay on screen until dismissed;
 *  normal ones (a BYE, our own cancel or decline) clear by themselves. */
export interface EndDescription {
  title: string;
  /** Mono detail line: SIP status, Reason header, who ended it. "" when there is nothing. */
  detail: string;
  /** One sentence on what to do next, for endings the user can fix. */
  hint?: string;
  failed: boolean;
}

const WHO: Record<string, string> = {
  remote: "remote",
  local: "this browser",
  system: "this browser",
};

// JsSIP cause constants (JsSIP.C.causes) that end a call normally.
const NORMAL = new Set(["Bye", "Terminated"]);

export function sipDetail(info?: EndInfo | null): string {
  if (!info) return "";
  const parts: string[] = [];
  if (info.code) parts.push(`${info.code}${info.reason ? ` ${info.reason}` : ""}`);
  if (info.reasonHeader) parts.push(info.reasonHeader);
  // Without a SIP response the JsSIP cause is the only evidence (e.g. "Connection Error").
  if (!info.code && info.cause && !NORMAL.has(info.cause)) parts.push(info.cause);
  if (info.originator && parts.length) parts.push(`by ${WHO[info.originator] || info.originator}`);
  return parts.join(" · ");
}

export function describeEnd(info?: EndInfo | null): EndDescription {
  const cause = info?.cause || "";
  const local = info?.originator === "local";
  const detail = sipDetail(info);
  if (!cause || NORMAL.has(cause))
    return { title: "Call ended", detail: "", failed: false };
  if (local && (cause === "Canceled" || cause === "Canceled/Rejected"))
    return { title: "Call cancelled", detail: "", failed: false };
  if (local && cause === "Rejected")
    return { title: "Call declined", detail: "", failed: false };
  if (cause === "User Denied Media Access")
    return {
      title: "Microphone blocked",
      detail,
      hint: "Allow microphone access for this site in the browser, then call again.",
      failed: true,
    };
  const titles: Record<string, string> = {
    Busy: "Busy",
    Rejected: "Call rejected",
    "No Answer": "No answer",
    Unavailable: "Unavailable",
    "Not Found": "Number not found",
    "Address Incomplete": "Number incomplete",
    Canceled: "Call cancelled",
    "Request Timeout": "No response",
    "Connection Error": "Connection lost",
    "RTP Timeout": "Audio stopped",
  };
  return { title: titles[cause] || "Call failed", detail, failed: true };
}
