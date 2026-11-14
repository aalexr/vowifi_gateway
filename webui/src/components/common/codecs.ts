/** SDP codec names ("AMR-WB/16000", as the call log stores them) for display, and their
 *  gateway codec keys (engine render.py carrier codecs). */

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

/** The gateway codec key for an SDP codec ("AMR-WB/16000" -> "amrwb"), or undefined. */
export function codecSetting(sdp: string): string | undefined {
  return SETTING[encName(sdp)];
}

/** "EVS/16000,AMR-WB/16000,telephone-event/16000" -> "EVS, AMR-WB, DTMF". A codec listed
 *  more than once (several payload types / clock rates, e.g. DTMF at 8 and 48 kHz, MTS's
 *  three AMR variants) is shown once. */
export function sdpListLabel(list?: string | null): string {
  const labels = (list || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (encName(c) === "telephone-event" ? "DTMF" : codecLabel(c)));
  return [...new Set(labels)].join(", ");
}
