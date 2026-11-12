/** SDP codec names ("AMR-WB/16000", as the call log stores them) for display and for the
 *  line's carrier codec setting (control config.rs ims_codecs). */

const LABELS: Record<string, string> = {
  evs: "EVS",
  "amr-wb": "AMR-WB",
  amr: "AMR",
  g722: "G.722",
  pcma: "G.711 A-law",
  pcmu: "G.711 µ-law",
  opus: "Opus",
  g729: "G.729",
  gsm: "GSM",
};

const SETTING: Record<string, string> = {
  evs: "evs",
  "amr-wb": "amrwb",
  amr: "amr",
  g722: "g722",
  pcma: "alaw",
  pcmu: "ulaw",
};

const encName = (sdp: string) => sdp.split("/")[0].trim().toLowerCase();

/** "AMR-WB/16000" -> "AMR-WB", "PCMA/8000" -> "G.711 A-law"; unknown names as sent. */
export function codecLabel(sdp: string): string {
  return LABELS[encName(sdp)] ?? sdp.split("/")[0];
}

/** The ims_codecs key for an SDP codec, or undefined if the gateway can't use it there. */
export function codecSetting(sdp: string): string | undefined {
  return SETTING[encName(sdp)];
}

/** "EVS/16000,AMR-WB/16000,telephone-event/16000" -> "EVS, AMR-WB, DTMF". */
export function sdpListLabel(list?: string | null): string {
  return (list || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (encName(c) === "telephone-event" ? "DTMF" : codecLabel(c)))
    .join(", ");
}
